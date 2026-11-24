import { COMPUTER_TOOLS } from "./opencadre-clients.mjs";
import { manifestHub, readCliManifest, readUpdatePolicy } from "./opencadre-update-check.mjs";
// Informational only: this check never authorizes a tool, changes trust or installs software.
// Public manifest reads are keyless and independent of fleet identity so an identity failure can still carry recovery advice.
//
// LOADED LAZILY (PR-E1, addendum §3.3). The awareness hook and the MCP proxy import this module with a memoised dynamic
// import and a catch, so a load or call failure here costs the notice and the build report, never a chat's identity.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_MS = 6 * 3600_000;
const NOTICE_MS = 24 * 3600_000;
// The hook's budget: a slow hub costs a chat at most this, once per six hours.
const MANIFEST_TIMEOUT_MS = 2000;
const readState = (file) => {
  try { const state = JSON.parse(readFileSync(file, "utf8")); return state && typeof state === "object" && !Array.isArray(state) ? state : {}; }
  catch { return {}; }
};
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{12}$/;

// The command is reconstructed from the configured hub, never copied from server-provided prose.
// Reject shell metacharacters, credentials and query strings before building executable advice. The build report keeps
// this rule (http allowed: it is credentialed inventory, not an update read); the update check uses manifestHub, which
// also requires https unless the hub is loopback.
function safeBase(base) {
  try {
    const u = new URL(base);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash
      || !/^[a-zA-Z0-9._:\[\]-]+$/.test(u.hostname) || !/^[a-zA-Z0-9._/-]*$/.test(u.pathname)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}

function localBundle(entryUrl) {
  const dir = dirname(fileURLToPath(entryUrl));
  const generated = ID.test(basename(dir)) && basename(dirname(dir)) === ".gen";
  const legacy = basename(dir) === "bin" && basename(dirname(dir)) === ".opencadre";
  // Repository hooks are development sources, not a customer installation to upgrade.
  if (!generated && !legacy) return null;
  let meta;
  try {
    const file = join(dir, generated ? ".generation.json" : ".opencadre-install.json");
    const st = lstatSync(file);
    if (st.isFile() && !st.isSymbolicLink() && st.size <= 512 * 1024) meta = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* unknown is explicit */ }
  const helpers = meta?.helpers;
  const valid = helpers && typeof helpers === "object" && !Array.isArray(helpers)
    && Object.keys(helpers).length > 0 && Object.values(helpers).every((h) => typeof h === "string" && HEX64.test(h));
  return { dir, root: generated ? dirname(dirname(dir)) : dir, id: generated ? basename(dir) : ID.test(meta?.stamp) ? meta.stamp : "unknown", helpers: valid ? helpers : null };
}

const REPORT_NAME = /^(?:opencadre-[a-z0-9-]+\.mjs|pure-ack\.mjs|opencadre-kilo-plugin\.js|opencode-plugin\/(?:index|mail|clearance)\.js)$/;

/** The installed files hashed against the install's own metadata, bounded (≤ 32 files, ≤ 1 MiB each, ≤ 4 MiB in all):
 * { integrity, helpers }. integrity is "unknown" (no usable metadata, or names this check does not manage),
 * "matches-metadata", or "modified-or-missing". Shared by the build report and the notice, so both say the same thing. */
function hashInstalled(local) {
  let integrity = "unknown";
  let helpers = null;
  const names = Object.keys(local.helpers ?? {});
  if (names.length > 0 && names.length <= 32 && names.every((name) => name.length <= 80 && REPORT_NAME.test(name))) {
    helpers = {};
    integrity = "matches-metadata";
    const realDir = realpathSync(local.dir);
    let total = 0;
    for (const name of names) {
      try {
        const file = join(local.dir, name);
        const stat = lstatSync(file);
        const rel = relative(realDir, realpathSync(file));
        if (!stat.isFile() || stat.isSymbolicLink() || isAbsolute(rel) || rel.startsWith("..") || stat.size > 1024 * 1024 || (total += stat.size) > 4 * 1024 * 1024) throw new Error("unmanaged helper");
        const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
        helpers[name] = actual;
        if (actual !== local.helpers[name]) integrity = "modified-or-missing";
      } catch { integrity = "modified-or-missing"; }
    }
    if (!Object.keys(helpers).length) helpers = null;
  }
  return { integrity, helpers };
}

/** The advisory update notice, or "" when there is nothing to say.
 *
 * POLICY FIRST (PR-E1): this computer's update policy (opencadre-update-check.mjs) is read before anything else. Under
 * `off` it returns "" with no network read and no write of any kind. `home` names the home holding .opencadre, as the
 * rest of OpenCadre does (OPENCADRE_HOOK_HOME, else the OS home). */
export async function connectorUpdateNotice({ base, stateDir, entryUrl = import.meta.url, now = Date.now(), fetcher = fetch, home = process.env.OPENCADRE_HOOK_HOME || homedir(), env = process.env } = {}) {
  if (readUpdatePolicy({ home, env }).policy === "off") return "";
  const checkedHub = manifestHub(base);
  if (!checkedHub.ok || !stateDir) return "";
  const hub = checkedHub.hub;
  let local;
  try { local = localBundle(entryUrl); } catch { return ""; }
  if (!local) return "";
  const tag = createHash("sha256").update(`${hub}\n${local.root}`).digest("hex").slice(0, 24);
  const stateFile = join(stateDir, `opencadre-update-${tag}.json`);
  // Adjacent bucket claims overlap, so a start at a six-hour boundary cannot race its
  // neighbor. A crashed claim expires after at most two buckets, never permanently.
  const bucket = Math.floor(now / CHECK_MS);
  const lockFiles = [bucket, bucket + 1].map((b) => `${stateFile}.${b}.lock`);
  let state = readState(stateFile);
  if (Number.isFinite(state.checkedAt) && now >= state.checkedAt && now - state.checkedAt < CHECK_MS) return "";
  const locks = [];
  const releaseLocks = () => {
    for (const { fd, file } of locks) {
      try { closeSync(fd); } catch { /* best effort */ }
      try { unlinkSync(file); } catch { /* only this check's claims */ }
    }
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    for (const old of [bucket - 3, bucket - 4]) { try { unlinkSync(`${stateFile}.${old}.lock`); } catch { /* our old advisory cache only */ } }
    for (const file of lockFiles) locks.push({ fd: openSync(file, "wx", 0o600), file });
  } catch { releaseLocks(); return ""; } // another chat owns this check, or state is unwritable: keep working
  const temp = `${stateFile}.${randomUUID()}.tmp`;
  try {
    // Read again after ownership so simultaneous starts do not produce duplicate notices.
    state = readState(stateFile);
    if (Number.isFinite(state.checkedAt) && now >= state.checkedAt && now - state.checkedAt < CHECK_MS) return "";
    state.checkedAt = now;
    let notice = "";
    try {
      // The one bounded reader (opencadre-update-check.mjs): no redirect, 2 s for headers AND body, 4 MiB, shape checked.
      const read = await readCliManifest(hub, { timeoutMs: MANIFEST_TIMEOUT_MS, fetcher });
      const hashes = read.ok ? read.helpers : null;
      if (hashes) {
        const stamp = read.stamp;
        const differs = !local.helpers || Object.keys(hashes).some((n) => local.helpers[n] !== hashes[n]);
        const areas = local.helpers ? [
          [["opencadre-config.mjs", "opencadre-clients.mjs", "opencadre-session-stamp.mjs", "opencadre-mcp.mjs"], "identity/proxy"],
          [["opencadre-awareness.mjs", "opencadre-wake.mjs", "pure-ack.mjs"], "mail/awareness"],
          [["opencadre-approval-gate.mjs", "opencadre-approval-gate-loader.mjs", "opencadre-hook-dialect.mjs"], "clearance/hooks"],
          [["opencadre-update-notice.mjs", "opencadre-update-check.mjs"], "upgrade notices"],
        ].filter(([names]) => names.some((n) => hashes?.[n] && local.helpers[n] !== hashes[n])).map(([, area]) => area) : [];
        const changed = local.helpers ? areas.length ? `Changed bundle areas: ${areas.join(", ")}. ` : "Other helper files differ. " : "Installed helper metadata is unknown. ";
        const announced = state.announcedStamp === stamp && Number.isFinite(state.announcedAt)
          && now >= state.announcedAt && now - state.announcedAt < NOTICE_MS;
        if (differs && !announced) {
          // Installed identity (addendum §3.1): the running bundle and whether its files match its own install record,
          // hashed with the build report's bounds. A mixed or modified set is never offered as an optional update.
          let integrity = "unknown";
          try { if (local.helpers) integrity = hashInstalled(local).integrity; } catch { /* unreadable install folder: say "not checked" */ }
          const running = !local.helpers ? "running bundle unknown"
            : integrity === "matches-metadata" ? `running bundle ${local.id} (files match its install record)`
            : integrity === "modified-or-missing" ? `running bundle ${local.id} (some files differ from its install record or are missing)`
            : `running bundle ${local.id} (from its install record; files not checked)`;
          // Current identity: the hub's package stamp and, when the manifest describes it, its build digest.
          const current = `hub package ${stamp}${read.build ? `, build ${read.build.inputsDigest.slice(0, 12)}` : ""}`;
          const head = integrity === "modified-or-missing"
            ? `OpenCadre connector files on this computer do not match their install record: ${running}; ${current}. This is not an optional update notice: run doctor first, which names each file. `
            : `OpenCadre connector update available (optional): ${running}; ${current}. The helper bundles differ; this is not a compatibility verdict. `;
          notice = `${head}${changed}Check identity, mail and clearance with doctor. `
            + `Upgrade command: npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade\n`
            + `Before upgrading, save work and close affected tools. Reopen them afterwards; open chats keep the helpers they started with until they are restarted. Review changed hooks and use Trust only after review if the app asks. `
            + `An agent can prepare the upgrade; do not approve hook trust automatically. Do not use a bare cached package URL.`;
          state.announcedStamp = stamp;
          state.announcedAt = now;
        }
      }
    } catch { /* unavailable or malformed manifest cannot block a session or invent an upgrade command */ }
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, stateFile);
    return notice;
  } catch { return ""; }
  finally {
    releaseLocks();
    try { unlinkSync(temp); } catch { /* rename succeeded */ }
  }
}

// Optional inventory uses only the selected computer credential. It names no chat and grants no permission.
// Callers must skip this for named-agent/override configurations rather than borrowing a machine credential.
//
// NOT GOVERNED BY THE UPDATE POLICY, deliberately (PR-E amendment 2): this is separate, credentialed connector build
// telemetry that feeds the console's per-computer label, not an update poll. It reads nothing from the hub about updates
// and installs nothing. `update --policy off` stops the advisory manifest check above; this report behaves as before.
export async function reportConnectorBuild({ base, credential, client, component = "hooks", stateDir, entryUrl = import.meta.url, now = Date.now(), fetcher = fetch } = {}) {
  const hub = safeBase(base);
  if (!hub || !/^dev_[0-9a-f]{48}$/.test(credential) || !COMPUTER_TOOLS.includes(client) || !["hooks", "proxy"].includes(component) || !stateDir) return;
  const locks = [];
  let temp;
  try {
    const local = localBundle(entryUrl);
    if (!local) return;
    // The path never leaves the computer, and the installation ID cannot correlate installations across credentials.
    const installationId = createHmac("sha256", credential).update(local.root).digest("hex").slice(0, 32);
    const tag = createHash("sha256").update(`${hub}:${installationId}:${client}:${component}:${local.id}`).digest("hex").slice(0, 24);
    const stateFile = join(stateDir, `opencadre-build-${tag}.json`);
    const fresh = () => { const state = readState(stateFile); return Number.isFinite(state.checkedAt) && now >= state.checkedAt && now - state.checkedAt < CHECK_MS; };
    if (fresh()) return;
    mkdirSync(stateDir, { recursive: true });
    const bucket = Math.floor(now / CHECK_MS);
    for (const old of [bucket - 3, bucket - 4]) { try { unlinkSync(`${stateFile}.${old}.lock`); } catch {} }
    for (const b of [bucket, bucket + 1]) { const file = `${stateFile}.${b}.lock`; locks.push({ fd: openSync(file, "wx", 0o600), file }); }
    if (fresh()) return;
    const { integrity, helpers } = hashInstalled(local);
    const body = { schema: 1, client, component, installationId, bundleId: ID.test(local.id) ? local.id : null, integrity, helpers };
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > 8192) return;
    try {
      const res = await fetcher(`${hub}/v1/devices/connector-build`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: serialized });
      // No response body is needed. An older hub's 404 or billing refusal is silent and cannot block ordinary tools.
      void res.body?.cancel().catch(() => {});
    } catch { /* offline reporting never interrupts work */ }
    temp = `${stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ checkedAt: now }), { mode: 0o600 });
    renameSync(temp, stateFile);
  } catch { /* malformed local metadata or an unwritable advisory cache does not affect identity */ }
  finally {
    for (const { fd, file } of locks) { try { closeSync(fd); } catch {} try { unlinkSync(file); } catch {} }
    if (temp) { try { unlinkSync(temp); } catch {} }
  }
}
