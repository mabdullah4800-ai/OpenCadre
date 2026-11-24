#!/usr/bin/env node
// reasonix-lock-doctor.mjs -- find and clear ORPHANED Reasonix lock files.
//
// WHY THIS EXISTS
// A Reasonix session that holds the workspace-writer claim takes a lock file in
// ~/.reasonix/locks/. If that session's write is CANCELLED (turn interrupted,
// process killed, machine slept) the lock file is left behind: it names no
// owner, carries no pid, and the harness never reclaims it. The next writer
// then queues behind a holder that does not exist and says, in as many words,
// "this task resumes after the conflicting file or workspace-wide write" --
// promising a resume after a write that is not running. Measured on
// 2026-09-17: twelve such files, oldest four hours old, none with a live owner,
// were blocking every writer in the workspace; clearing them restored writes
// immediately.
//
// A lock is treated as ORPHANED when it has not been touched for --age minutes
// (default 30). That is deliberately the same staleness rule this repo already
// uses for the wake lock in scripts/opencadre-wake.mjs: a lock untouched for
// longer than its owner could possibly go without polling belongs to a dead
// owner. Do NOT re-invent a different rule here.
//
// WHAT IT DOES NOT DO
// It cannot tell you WHY a lock was orphaned, and it does not fix the defect --
// a cancelled write should release its claim. This is the recovery tool, not
// the cure; the harness bug is tracked separately.
//
// USAGE
//   node scripts/reasonix-lock-doctor.mjs              # report only (default)
//   node scripts/reasonix-lock-doctor.mjs --age 10     # lower the orphan bar
//   node scripts/reasonix-lock-doctor.mjs --apply      # clear orphans (backs them up first)
//   node scripts/reasonix-lock-doctor.mjs --json       # machine-readable
//
// Reporting is the default, on purpose: silently deleting lock files while
// another agent is mid-write is a worse failure than a stalled queue.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { reasonixRoots } from "./opencadre-config.mjs";

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? fallback : argv[i + 1];
};
const AGE_MINUTES = Number(valueOf("age", "30"));
const APPLY = argv.includes("--apply");
const AS_JSON = argv.includes("--json");

if (!Number.isFinite(AGE_MINUTES) || AGE_MINUTES <= 0) {
  console.error("--age must be a positive number of minutes");
  process.exit(2);
}

/** Every directory the harness may park a lock in. The config-side root is taken from reasonixRoots()
 * rather than restated here, so "where Reasonix lives" is defined once.
 *
 * NOT reasonixRoots() mapped. The two lists are asymmetric on purpose: the config root carries the
 * repair-mutation-locks family, while the OTHER family sits in a `locks` sub-directory of ~/.reasonix.
 * On POSIX reasonixRoots() lists the config root first, so mapping it would hand each lock family to
 * the other's root AND silently reorder the scan. */
export function lockRoots(home = homedir(), env = process.env) {
  return [
    join(home, ".reasonix", "locks"),
    join(reasonixRoots(home, env)[0], "repair-mutation-locks"),
  ];
}

/** All *.lock files under the roots. The locks root holds one sub-directory per
 * lock family (e.g. config-edits-<hash>/), so walk two levels. */
export function findLocks(roots = lockRoots(), now = Date.now()) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist is not an error -- not every host has every family
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
      } else if (entry.name.endsWith(".lock")) {
        let mtimeMs;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue; // vanished between listing and stat -- another doctor got there first
        }
        const ageMinutes = (now - mtimeMs) / 60_000;
        found.push({ path, ageMinutes, orphaned: ageMinutes >= AGE_MINUTES });
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return found.sort((a, b) => b.ageMinutes - a.ageMinutes);
}

const minutes = (n) => (n < 1 ? "<1" : String(Math.floor(n))).padStart(4);

function main() {
  const locks = findLocks();
  const orphans = locks.filter((l) => l.orphaned);

  // --sweep: the AUTOMATED mode, run from a registered session hook on every prompt and every tool
  // call. It clears orphans and reports on stderr, which does not enter the model's context. It
  // ALWAYS returns 0, because a non-zero exit from a pre-tool hook can be read as a DENIAL, and a
  // maintenance sweep must never block the call it precedes. No backup: every lock file observed
  // here was 0 bytes, so the stderr line is the whole record.
  //
  // NOTE ON THE CALLER: as of 2026-09-18 no committed branch registers a caller for this mode --
  // scripts/reasonix-opencadre-hook.mjs, which sweeps on PostToolUse and UserPromptSubmit, exists
  // only on unmerged branches, and this machine runs it by hand. The mode is written to be safe
  // under a hook, but do not assume one is wired up.
  if (argv.includes("--sweep")) {
    for (const lock of orphans) {
      try {
        rmSync(lock.path);
        console.error(
          `opencadre-lock-sweep: cleared ORPHANED lock ${lock.path} (untouched ${Math.floor(lock.ageMinutes)}m)`,
        );
      } catch {
        // Another sweeper removed it between the scan and the delete. Nothing to do.
      }
    }
    return 0;
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ageMinutes: AGE_MINUTES, applied: APPLY, locks, orphans: orphans.length }, null, 2));
  } else {
    console.log(`Reasonix lock doctor -- orphan bar: untouched for ${AGE_MINUTES}+ minutes\n`);
    if (locks.length === 0) {
      console.log("  no lock files found. If a write is still blocked, the holder is NOT a lock file;");
      console.log("  check for a running git process and a stale .git/index.lock before concluding.");
    } else {
      for (const lock of locks) {
        console.log(`  ${lock.orphaned ? "ORPHAN" : "  live"}  ${minutes(lock.ageMinutes)}m  ${lock.path}`);
      }
      console.log(`\n  ${locks.length} lock(s), ${orphans.length} orphaned.`);
    }
    // The hint lives in the HUMAN branch only. Emitting it in --json mode broke every consumer:
    // JSON.parse() met a trailing text line and threw, so a caller that asked for machine-readable
    // output got nothing and stayed silent. A --json mode must emit JSON and NOTHING else.
    if (orphans.length > 0 && !APPLY) {
      console.log(`\n  Re-run with --apply to clear the ${orphans.length} orphan(s). They are backed up first.`);
    }
  }

  if (!APPLY || orphans.length === 0) return 0;

  const backup = join(tmpdir(), `reasonix-lock-doctor-${Date.now()}`);
  mkdirSync(backup, { recursive: true });
  let cleared = 0;
  for (const lock of orphans) {
    try {
      const dest = join(backup, lock.path.replace(/[:\\/]/g, "_"));
      copyFileSync(lock.path, dest);
      rmSync(lock.path);
      cleared += 1;
    } catch (error) {
      console.error(`  could not clear ${lock.path}: ${error.message}`);
    }
  }
  if (!AS_JSON) {
    console.log(`\n  cleared ${cleared} orphaned lock(s); backups in ${backup}`);
    console.log("  verify a write works now before telling anyone the queue is fixed.");
  }
  return cleared === orphans.length ? 0 : 1;
}

// Only run when invoked directly, so tests can import the helpers without
// sweeping the developer's real lock directories.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  process.exit(main());
}
