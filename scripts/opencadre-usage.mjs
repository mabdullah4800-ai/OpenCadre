#!/usr/bin/env node
// Reports this agent's subscription usage to the hub, so the fleet can tell "out of usage" from
// "crashed" and see a limit coming. Zero dependencies.
//
//   node scripts/opencadre-usage.mjs --client codex
//       Codex Stop hook: the last rate_limits in the newest ~/.codex/sessions rollout file.
//   node scripts/opencadre-usage.mjs --client claude-code --from-stdin
//       Claude Code statusLine command: maps the rate_limits in the statusLine JSON on stdin and
//       prints a short status line (a statusLine command must print one).
//
// Installed by scripts/install-session-hooks.mjs. The hub and key come from opencadre-config.mjs.
// Posts to /v1/usage at most once a minute per key, and only when the report changed or 5 minutes
// have passed, tracked in <state dir>/usage-<key hash>.json (never the key itself). Never blocks,
// never prints the key: every failure exits 0.
//
// Env: OPENCADRE_HOOK_HOME (home holding .codex, default ~), OPENCADRE_WAKE_STATE_DIR (~/.opencadre)
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome } from "./opencadre-clients.mjs";
import { HOST_SESSION_HEADER, resolveHub, SESSION_HEADER } from "./opencadre-config.mjs";

const CHECK_MS = 60_000;
const REPOST_MS = 5 * 60_000;

const args = process.argv.slice(2);
const client = args.includes("--client") ? args[args.indexOf("--client") + 1] : undefined;

const two = (n) => String(n).padStart(2, "0");
// The time-value limit is in MILLISECONDS, so the range check must be made on the milliseconds.
// `Number.isFinite` alone is wider than `new Date(ms).toISOString()` accepts — 1e18 is finite and
// throws RangeError — and that throw escapes the windows map below and is swallowed by the
// entry-point catch, silently dropping the WHOLE report for that agent, which is the one failure
// this script exists to make visible from the hub.
const MAX_TIME_MS = 8.64e15;
const iso = (epochSeconds) => {
  if (!Number.isFinite(epochSeconds)) return null;
  const ms = epochSeconds * 1000;
  return Math.abs(ms) <= MAX_TIME_MS ? new Date(ms).toISOString() : null;
};
const windowLabel = (minutes) =>
  !Number.isFinite(minutes) || minutes <= 0 ? null : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

// The fullest window is the one that will stop the agent first.
function report(windows, { limited = false, plan = null, source }) {
  const present = windows.filter((w) => w && Number.isFinite(w.usedPct));
  if (present.length === 0) return null;
  const top = present.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  const usedPct = Math.min(Math.max(top.usedPct, 0), 100);
  return { usedPct, window: top.window, resetsAt: top.resetsAt, limited: limited || usedPct >= 100, plan, source };
}

const listDir = (dir) => {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
};

// sessions/YYYY/MM/DD/rollout-*.jsonl: names sort by date, so walk the newest branch holding a rollout.
function newestRollout(home) {
  // Through the one resolver: a relocated CODEX_HOME keeps its rollout logs under the new root, and
  // reading the default would silently report "no sessions" for an install that has plenty (§9 item 7).
  const root = join(codexHome(home), "sessions");
  for (const y of listDir(root)) for (const m of listDir(join(root, y))) for (const d of listDir(join(root, y, m))) {
    const day = join(root, y, m, d);
    const files = listDir(day).filter((f) => /^rollout-.*\.jsonl$/.test(f)).map((f) => join(day, f));
    // Parallel sessions share a day; the most recently written one knows the latest limits.
    if (files.length > 0) return files.reduce((a, b) => (statSync(b).mtimeMs > statSync(a).mtimeMs ? b : a));
  }
  return null;
}

const findObject = (node, name) => {
  if (!node || typeof node !== "object") return null;
  if (node[name] && typeof node[name] === "object") return node[name];
  for (const value of Object.values(node)) {
    const found = findObject(value, name);
    if (found) return found;
  }
  return null;
};

function codexReport() {
  const file = newestRollout(process.env.OPENCADRE_HOOK_HOME || homedir());
  if (!file) return null;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let limits;
    try {
      limits = findObject(JSON.parse(lines[i]), "rate_limits");
    } catch {
      continue;
    }
    if (!limits) continue;
    const windows = [limits.primary, limits.secondary].map((w) => w && { usedPct: w.used_percent, window: windowLabel(w.window_minutes), resetsAt: iso(w.resets_at) });
    return report(windows, {
      limited: limits.rate_limit_reached_type != null,
      plan: typeof limits.plan_type === "string" ? limits.plan_type.slice(0, 40) : null,
      source: "codex",
    });
  }
  return null;
}

// rate_limits appears only for Pro/Max subscribers after the session's first API response.
function claudeCodeReport(input) {
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const windows = [["5h", limits.five_hour], ["7d", limits.seven_day]]
    .map(([window, w]) => w && { usedPct: w.used_percentage, window, resetsAt: iso(w.resets_at) });
  return report(windows, { source: "claude-code" });
}

function statusLine(r) {
  if (!r) return "usage n/a";
  if (!r.limited) return `usage ${Math.round(r.usedPct)}% · ${r.window}`;
  const d = r.resetsAt && new Date(r.resetsAt);
  return `out of usage · resets ${d ? `${two(d.getHours())}:${two(d.getMinutes())}` : "unknown"}`;
}

async function post(usage, cwd, sessionId) {
  const { base, key, headers = {} } = resolveHub({ client, cwd, sessionId });
  if (!base || !key) return;
  const dir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre");
  // A device credential serves many sessions, each its own agent: gate per session, not per credential.
  const session = headers[HOST_SESSION_HEADER] || headers[SESSION_HEADER];
  const file = join(dir, `usage-${createHash("sha256").update(session ? `${key}\n${session}` : key).digest("hex").slice(0, 16)}.json`);
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* first report for this key */ }
  const save = (next) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(next));
    } catch { /* best-effort: worst case it posts a little more often */ }
  };
  const now = Date.now();
  // A statusLine command runs on every UI update, so the minute gate applies before anything else.
  if (now - (state.checkedAt ?? 0) < CHECK_MS) return;
  const body = JSON.stringify(usage);
  save({ ...state, checkedAt: now });
  if (body === state.body && now - (state.postedAt ?? 0) < REPOST_MS) return;
  const res = await fetch(`${base}/v1/usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) save({ checkedAt: now, postedAt: now, body });
}

try {
  let input = {};
  if (args.includes("--from-stdin")) {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    try {
      input = JSON.parse(raw || "{}");
    } catch { /* no usable input: nothing to report */ }
  }
  let usage = null;
  try {
    usage = client === "codex" ? codexReport() : client === "claude-code" ? claudeCodeReport(input) : null;
  } catch { /* unreadable session files: nothing to report */ }
  if (client === "claude-code") console.log(statusLine(usage));
  if (usage) await post(usage, input.cwd, typeof input.session_id === "string" ? input.session_id : undefined);
} catch { /* never fail the client's hook or status line */ }
