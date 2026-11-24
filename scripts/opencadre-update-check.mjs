// The update check's shared pieces (PR-E1): this computer's update POLICY, and the ONE bounded reader of the hub's public
// CLI manifest that the advisory notice, doctor, `update --check` and `connect --upgrade` all use.
//
// NODE BUILTINS ONLY, BY CONTRACT. It is a helper library inside every generation (cli/lib/helpers.mjs HELPERS) and the
// CLI loads it through helperSource, so it imports no sibling: nothing it depends on can be missing from a generation.
//
// THE POLICY (plan PR-E §4, ruling: Olive's review of PLAN-PR-E 5e136886 + addendum e9e85fa2):
//   off < notify < auto, most to least restrictive. The effective policy is the MOST restrictive of this computer's
//   stored choice and every ceiling (the OPENCADRE_UPDATE_POLICY environment ceiling now; a workspace ceiling is a FUTURE
//   input with no source in this release). No input can raise another.
//   - No file: notify, which is what every install did before this file existed.
//   - A file that cannot be read or does not parse as schema 1: OFF for background work (the most restrictive reading).
//     doctor and `update --status` say so and name the fix.
//   - `auto` is NOT AVAILABLE in this release. It cannot be written (writeUpdatePolicy refuses it) and a stored `auto` is
//     treated as notify, with the reason, because automatic updates need a person-authorized consent mechanism that does
//     not exist yet (Olive R1).
//   - `off` stops the advisory update check: no manifest read, no state written. It does NOT stop the separate, credentialed
//     connector build report (reportConnectorBuild in opencadre-update-notice.mjs), which is inventory telemetry for the
//     console, not an update poll (PR-E amendment 2). A check the user asks for (doctor, `update --check`,
//     `connect --upgrade`) still reads the manifest under every policy.
//
// THE MANIFEST READER (plan PR-E §5.2):
//   - credential-free, `redirect: "error"`, `cache: "no-store"`;
//   - one deadline covering the headers AND the body (a stalled body is a timeout, not a hang);
//   - the body streamed with a 4 MiB cap and cancelled when it goes over;
//   - the hub must be https, except a loopback hub (127.0.0.1, localhost, [::1]);
//   - the answer's shape is validated, and the upgrade command is REBUILT from the hub asked and the validated stamp,
//     never copied from the answer's own `command` or `url`.
//   EFFECT ON A HUB THAT REDIRECTS (http -> https, a bare host -> www, a moved path): the read FAILS with "the hub answered
//   with a redirect, which is not followed". Nothing is installed and no command is printed; the fix is to use the hub's
//   final https address. The same is true of a plain-http hub that is not loopback.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------- policy ----------

/** Most to least restrictive. */
export const POLICIES = Object.freeze(["off", "notify", "auto"]);
const RANK = { off: 0, notify: 1, auto: 2 };
const known = (p) => typeof p === "string" && Object.hasOwn(RANK, p);
/** The values a person can set in this release. `auto` is not one of them. */
export const SETTABLE_POLICIES = Object.freeze(["notify", "off"]);
export const AUTO_UNAVAILABLE = "Automatic updates are not available yet: choose `--policy notify` (the default: hooks tell a chat when an update is available) or `--policy off` (no background update check). Nothing was changed.";
const POLICY_MAX_BYTES = 64 * 1024;

/** <home>/.opencadre/update-policy.json, beside credentials.json and never inside it, so a policy write cannot rewrite
 * the file that holds the credential. */
export const updatePolicyPath = (home) => join(home, ".opencadre", "update-policy.json");

/** The most restrictive of the computer's policy and every ceiling. An unknown value anywhere reads as `off`. */
export function effectivePolicy(computer, { workspaceCeiling = null, envCeiling = null } = {}) {
  return [computer, workspaceCeiling ?? "auto", envCeiling ?? "auto"]
    .map((p) => (known(p) ? p : "off"))
    .reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** This computer's stored choice: { stored, computer, source, reason }.
 *   source "default"    no file: computer = notify
 *   source "file"       a valid schema-1 file
 *   source "unreadable" a file that cannot be read or is not schema 1: computer = off */
function readStored(home) {
  const file = updatePolicyPath(home);
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { stored: null, computer: "notify", source: "default", reason: null };
    return { stored: null, computer: "off", source: "unreadable", reason: `the update policy file could not be read (${err?.code ?? "error"})` };
  }
  if (!st.isFile() || st.isSymbolicLink()) return { stored: null, computer: "off", source: "unreadable", reason: "the update policy file is not a regular file" };
  if (st.size > POLICY_MAX_BYTES) return { stored: null, computer: "off", source: "unreadable", reason: "the update policy file is too large" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { stored: null, computer: "off", source: "unreadable", reason: err?.code ? `the update policy file could not be read (${err.code})` : "the update policy file is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema !== 1 || !known(parsed.policy)) {
    return { stored: null, computer: "off", source: "unreadable", reason: "the update policy file is not a known policy (schema 1: off, notify or auto)" };
  }
  if (parsed.policy === "auto") {
    // A stored auto needs a person-authorized consent record this release cannot create or check, so it only notifies.
    return { stored: "auto", computer: "notify", source: "file", reason: "automatic updates are not available in this release, so this computer only notifies" };
  }
  return { stored: parsed.policy, computer: parsed.policy, source: "file", reason: null };
}

/** The environment ceiling: { ceiling, reason }. Unset or empty means none; an unrecognised value is `off`. The value is
 * never echoed (it is the operator's environment). */
function envCeilingOf(env) {
  const raw = env?.OPENCADRE_UPDATE_POLICY;
  if (raw === undefined || raw === "") return { ceiling: null, reason: null };
  const value = String(raw).trim().toLowerCase();
  if (known(value)) return { ceiling: value, reason: null };
  return { ceiling: "off", reason: "OPENCADRE_UPDATE_POLICY is set to a value that is not off, notify or auto, so it reads as off" };
}

/** This computer's effective update policy: { policy, stored, source, reasons }. `policy` is "notify" or "off" in this
 * release (never "auto"). `reasons` says why the effective policy is not simply the stored one, or why the file was
 * ignored. Never throws. */
export function readUpdatePolicy({ home, env = process.env } = {}) {
  const stored = home ? readStored(home) : { stored: null, computer: "notify", source: "default", reason: null };
  const { ceiling, reason: envReason } = envCeilingOf(env);
  // The workspace ceiling has no source in this release: a future input, never a shipped control.
  const policy = effectivePolicy(stored.computer, { envCeiling: ceiling });
  const reasons = [];
  if (stored.reason) reasons.push(stored.reason);
  if (envReason) reasons.push(envReason);
  else if (ceiling && RANK[ceiling] < RANK[stored.computer]) reasons.push(`OPENCADRE_UPDATE_POLICY limits this computer to ${ceiling}`);
  // Belt and braces: nothing in this release may yield auto.
  return { policy: policy === "auto" ? "notify" : policy, stored: stored.stored, source: stored.source, reasons };
}

/** Writes this computer's policy (notify or off) by temp file and rename, owner-only where the OS supports it. `auto`
 * is refused with AUTO_UNAVAILABLE. Returns the record written. */
export function writeUpdatePolicy({ home, policy, now = new Date() }) {
  if (policy === "auto") throw Object.assign(new Error(AUTO_UNAVAILABLE), { code: "AUTO_UNAVAILABLE" });
  if (!SETTABLE_POLICIES.includes(policy)) throw Object.assign(new Error(`Unknown update policy "${policy}": use notify or off.`), { code: "BAD_POLICY" });
  const file = updatePolicyPath(home);
  mkdirSync(join(home, ".opencadre"), { recursive: true, mode: 0o700 });
  const record = { schema: 1, policy, setAt: now.toISOString() };
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed */ }
  }
  return record;
}

// ---------- the manifest reader ----------

export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const TARBALL_MAX_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{12}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The hub as a base for building commands: { ok: true, hub } or { ok: false, reason }. Rejects credentials, query
 * strings, fragments and shell metacharacters (the command is built from it), and plain http unless the host is
 * loopback. */
export function manifestHub(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reason: "the hub address is not a URL" };
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash
    || !/^[a-zA-Z0-9._:\[\]-]+$/.test(u.hostname) || !/^[a-zA-Z0-9._/-]*$/.test(u.pathname)) {
    return { ok: false, reason: "the hub address is not a plain http(s) address" };
  }
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) return { ok: false, reason: "the hub is not https (plain http is accepted only for a loopback hub)" };
  return { ok: true, hub: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

const isHexMap = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.values(v).every((h) => typeof h === "string" && HEX64.test(h));
const isImports = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((d) => Array.isArray(d) && d.every((x) => typeof x === "string"));
const isHistory = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((d) => Array.isArray(d) && d.every((x) => typeof x === "string" && HEX64.test(x)));

/** Checks a parsed manifest: { ok: true, stamp, sha256, bytes, helpers, build } or { ok: false, reason }.
 * REQUIRED: tarball.stamp (12 hex), tarball.sha256 (64 hex, starting with the stamp), tarball.bytes (an integer in
 * [1, 16 MiB]), tarball.url (an http(s) URL whose path ends /cli/<stamp>/opencadre-cli.tgz) and a `command` naming that
 * path. VALIDATED WHEN PRESENT: helpers (a non-empty map of sha256), imports, inputsDigest, officialHistory; a present
 * but malformed one makes the whole answer malformed. `build` is non-null only when inputsDigest, helpers and imports are
 * all present (what an install can be verified against). */
export function validateManifest(body) {
  const bad = { ok: false, reason: "the answer is not a CLI manifest" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad;
  const t = body.tarball;
  if (!t || typeof t !== "object") return bad;
  const stamp = t.stamp;
  if (typeof stamp !== "string" || !ID.test(stamp)) return bad;
  if (typeof t.sha256 !== "string" || !HEX64.test(t.sha256) || !t.sha256.startsWith(stamp)) return bad;
  if (!Number.isInteger(t.bytes) || t.bytes < 1 || t.bytes > TARBALL_MAX_BYTES) return bad;
  let url;
  try {
    url = new URL(t.url);
  } catch {
    return bad;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/cli/${stamp}/opencadre-cli.tgz`)) return bad;
  if (typeof body.command !== "string" || !body.command.includes(`/cli/${stamp}/opencadre-cli.tgz`)) return bad;
  if (body.helpers !== undefined && !isHexMap(body.helpers)) return bad;
  if (body.imports !== undefined && !isImports(body.imports)) return bad;
  if (body.inputsDigest !== undefined && (typeof body.inputsDigest !== "string" || !HEX64.test(body.inputsDigest))) return bad;
  if (body.officialHistory !== undefined && !isHistory(body.officialHistory)) return bad;
  const build = body.inputsDigest !== undefined && body.helpers !== undefined && body.imports !== undefined
    ? { inputsDigest: body.inputsDigest, helpers: body.helpers, imports: body.imports }
    : null;
  return { ok: true, stamp, sha256: t.sha256, bytes: t.bytes, helpers: body.helpers ?? null, build };
}

class ReadFailure extends Error {
  constructor(reason, kind) {
    super(reason);
    this.reason = reason;
    this.kind = kind;
  }
}

/** Reads a response body as JSON with a byte cap, cancelling the stream when it goes over or when `signal` aborts. */
async function cappedJson(response, cap, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    void response.body?.cancel().catch(() => {});
    throw new ReadFailure(`the answer is larger than ${cap / (1024 * 1024)} MiB`, "too-large");
  }
  if (!response.body) throw new ReadFailure("the answer is empty", "malformed");
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new ReadFailure("deadline", "timeout");
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => {});
        throw new ReadFailure(`the answer is larger than ${cap / (1024 * 1024)} MiB`, "too-large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* a cancelled read may still hold it */ }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReadFailure("the answer is not JSON", "malformed");
  }
}

const isRedirectError = (err) => /redirect/i.test(String(err?.cause?.message ?? "")) || /redirect/i.test(String(err?.message ?? ""));

/** GET <hub>/cli/manifest.json, bounded and checked: { ok: true, hub, stamp, sha256, bytes, command, helpers, build } or
 * { ok: false, kind, reason }. `kind` is one of invalid-hub, unreachable, timeout, redirect, http, too-large,
 * malformed. Carries no credential. Never throws. */
export async function readCliManifest(base, { timeoutMs = 15_000, fetcher = fetch, maxBytes = MANIFEST_MAX_BYTES } = {}) {
  const checked = manifestHub(base);
  if (!checked.ok) return { ok: false, kind: "invalid-hub", reason: checked.reason };
  const { hub } = checked;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReadFailure(`no complete answer within ${Math.round(timeoutMs / 100) / 10} s`, "timeout"));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  try {
    let res;
    try {
      res = await Promise.race([fetcher(`${hub}/cli/manifest.json`, { redirect: "error", cache: "no-store", signal: controller.signal }), deadline]);
    } catch (err) {
      if (err instanceof ReadFailure) throw err;
      if (controller.signal.aborted) throw new ReadFailure(`no complete answer within ${Math.round(timeoutMs / 100) / 10} s`, "timeout");
      if (isRedirectError(err)) throw new ReadFailure("the hub answered with a redirect, which is not followed: use the hub's final https address", "redirect");
      throw new ReadFailure(`unreachable: ${err?.cause?.code ?? err?.name ?? err?.message}`, "unreachable");
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => {});
      throw new ReadFailure("the hub answered with a redirect, which is not followed: use the hub's final https address", "redirect");
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new ReadFailure(`HTTP ${res.status}`, "http");
    }
    let body;
    try {
      body = await Promise.race([cappedJson(res, maxBytes, controller.signal), deadline]);
    } catch (err) {
      if (controller.signal.aborted && err?.kind !== "too-large") throw new ReadFailure(`no complete answer within ${Math.round(timeoutMs / 100) / 10} s`, "timeout");
      throw err;
    }
    const valid = validateManifest(body);
    if (!valid.ok) throw new ReadFailure(valid.reason, "malformed");
    return {
      ok: true, hub, stamp: valid.stamp, sha256: valid.sha256, bytes: valid.bytes,
      // Rebuilt from the hub this reader asked and the validated stamp, never the answer's own command or url.
      command: `npx -y ${hub}/cli/${valid.stamp}/opencadre-cli.tgz connect --upgrade`,
      helpers: valid.helpers, build: valid.build,
    };
  } catch (err) {
    if (err instanceof ReadFailure) return { ok: false, kind: err.kind, reason: err.reason };
    return { ok: false, kind: "malformed", reason: "the answer could not be read" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
