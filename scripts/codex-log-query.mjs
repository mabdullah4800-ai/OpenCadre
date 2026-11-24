#!/usr/bin/env node
// Read-only queries over Codex's own log DB (~/.codex/logs_2.sqlite).
//
// This replaces four one-off scripts that each answered a single question about the
// same table. One file, one place to keep the two traps that cost time here:
//
//   1. `ts` is Unix epoch SECONDS, not ISO. Comparing it to an ISO string returns
//      zero rows silently rather than erroring.
//   2. `ts` is also too coarse to key on - the table carries `ts_nanos`, and
//      deduping by `ts` merges genuinely distinct launches. Count rows, or key on
//      ts_nanos, never on `ts`.
//
// And one scoping rule: `Service initialized` is emitted by EVERY MCP server in
// the log, not just OpenCadre. Unscoped it is 128 rows; scoped to
// `server_name=opencadre-session` it is 14. Always name the set.
//
// Usage:
//   node scripts/codex-log-query.mjs launches      [days]   # launches per Codex process
//   node scripts/codex-log-query.mjs kinds                  # what the launcher target holds
//   node scripts/codex-log-query.mjs spans <pid>            # raw OpenCadre rows for one process
//   node scripts/codex-log-query.mjs threads                # thread ids per process
//
// Node: use the arm64 binary on this machine -
//   C:\Users\dev\node-arm64\node-v22.22.3-win-arm64\node.exe

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHER = "codex_rmcp_client::stdio_server_launcher";
const INIT_LIKE = "%server_name=opencadre-session%Service initialized%";

const [, , command = "launches", arg] = process.argv;
const db = new DatabaseSync(join(homedir(), ".codex", "logs_2.sqlite"), { readOnly: true });
const days = Number(arg) || 10;
const since = Math.floor(Date.now() / 1000) - days * 86400;

/** OpenCadre init rows for a process, and the logical launches they group into. */
function launchesFor(uuid) {
  const rows = db
    .prepare(`select ts, ts_nanos from logs where process_uuid = ? and feedback_log_body like ? order by ts, ts_nanos`)
    .all(uuid, INIT_LIKE);
  // Distinct launches = distinct ts_nanos. Do NOT dedupe on ts (see header).
  const nanos = new Set(rows.map((r) => r.ts_nanos));
  const secs = new Set(rows.map((r) => r.ts));
  return { rows: rows.length, launches: nanos.size, seconds: secs.size };
}

if (command === "launches") {
  const procs = db
    .prepare("select distinct process_uuid from logs where ts >= ?")
    .all(since)
    .map((r) => r.process_uuid);

  console.log(`window: last ${days}d  |  process | launch rows | launches | distinct seconds | thread ids | launcher rows`);
  for (const uuid of procs.sort()) {
    const l = launchesFor(uuid);
    const launcherRows = db
      .prepare("select count(*) c from logs where process_uuid = ? and target = ?")
      .get(uuid, LAUNCHER).c;
    const threads = db
      .prepare("select count(distinct thread_id) c from logs where process_uuid = ? and thread_id is not null")
      .get(uuid).c;
    if (!l.rows && !threads && !launcherRows) continue;
    console.log(
      `  ${uuid.slice(0, 14).padEnd(14)} | ${String(l.rows).padStart(4)} | ${String(l.launches).padStart(4)} | ` +
        `${String(l.seconds).padStart(4)} | ${String(threads).padStart(4)} | ${launcherRows}`
    );
  }
  console.log("\nlaunches = distinct ts_nanos (the right key). seconds shown only to expose the trap.");
}

if (command === "kinds") {
  const rows = db.prepare(`select feedback_log_body as b from logs where target = ?`).all(LAUNCHER);
  const kinds = new Map();
  for (const r of rows) {
    const kind = (r.b || "")
      .replace(/\s+/g, " ")
      .replace(/\(.*?\)/, "(<exe>)")
      .replace(/ws:\/\/localhost:\d+/g, "ws://localhost:<port>")
      .trim()
      .slice(0, 110);
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
  }
  console.log(`total launcher rows: ${rows.length} - these are stderr INSTRUMENTS, one per message,`);
  console.log("not one per launch, and the target is shared with other MCP servers (another-mcp).\n");
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)} | ${k}`);
  }
}

if (command === "spans") {
  const pid = arg || "3900";
  console.log(`raw OpenCadre rows for process_uuid like 'pid:${pid}:%', in time order:\n`);
  for (const r of db
    .prepare(
      `select ts, ts_nanos, thread_id, feedback_log_body as b from logs
        where process_uuid like ? and feedback_log_body like '%opencadre%' order by ts, ts_nanos`
    )
    .all(`pid:${pid}:%`)) {
    console.log(`${new Date(r.ts * 1000).toISOString().slice(11, 23)} | tid=${(r.thread_id || "-").slice(0, 8)} | ${(r.b || "").replace(/\s+/g, " ").slice(0, 130)}`);
  }
}

if (command === "threads") {
  const rows = db
    .prepare(
      `select process_uuid, count(distinct thread_id) c from logs
        where ts >= ? and thread_id is not null group by process_uuid order by c desc limit 25`
    )
    .all(since);
  console.log(`distinct thread_id per process, last ${days}d (whole-DB distinct: ${db.prepare("select count(distinct thread_id) c from logs where thread_id is not null").get().c}):`);
  for (const r of rows) console.log(`  ${r.process_uuid.slice(0, 14).padEnd(14)} | ${r.c}`);
  console.log("\nA per-process figure is not a whole-DB figure. pid:12200 = 138 against 315 whole-DB.");
}