#!/usr/bin/env node
// OpenCadre wake-on-mail: wakes an idle agent without a human. Zero dependencies,
// zero tokens while waiting.
//
// Run it as a BACKGROUND TASK of the agent session. It long-polls the inbox
// (peek-only, so it never steals mail), stays silent while idle, and EXITS with one
// line the moment real mail arrives. The task completing is what wakes the agent
// (Antigravity background tasks, Claude Code run_in_background, and so on). The
// agent handles the mail, then relaunches this script.
//
//   OPENCADRE_URL=https://hub.opencadre.example OPENCADRE_KEY=agt_... node opencadre-wake.mjs
//
// --rewake is for a Claude Code Stop hook with "asyncRewake": true (installed by
// install-session-hooks.mjs --client claude-code). The wake lines go to stderr and it exits 2,
// which wakes the idle session; every later Stop starts it again, so it never needs relaunching.
// --codex-queue is for an async Codex Stop hook: peek for mail, then queue a turn for the
// hook payload's session_id. Unconfigured sessions get a silent exit 0. --client <claude-code|codex|antigravity> picks
// which MCP config holds the key (see opencadre-config.mjs). On a connected machine with no named
// agent for the folder, it watches THIS session's own inbox (hook session_id, else
// CLAUDE_CODE_SESSION_ID), with a cursor and lock per session. The hub gives a session one agent per
// project (docs/design/PROJECT_ISOLATION.md §3.2), so each poll re-reads the folder's project and, when
// it changed, re-resolves the identity and watches that project's agent instead, without a restart.
//
// Never wakes for low priority or pure acknowledgements (VISION.md). A cursor file
// remembers the last message seen, so a relaunch never re-wakes for the same mail.
// A lock file lets only one watcher per key run, so repeated launches never wake twice.
// Every wake also appends one line to wake-history-<seat>.jsonl, so wakes per agent-hour is
// a number that can be read off disk rather than inferred from a cooldown setting.
// If the hub stays unreachable it exits with "OPENCADRE WAKE ERROR" rather than
// dying silently.
//
// Env: OPENCADRE_WAIT_SECONDS (50), OPENCADRE_WAKE_STATE_DIR (~/.opencadre),
//      OPENCADRE_WAKE_MAX_FAILURES (20), OPENCADRE_WAKE_RETRY_MS (5000),
//      OPENCADRE_WAKE_OWNER_CHECK_MS (15000: how often --rewake checks its chat is still there; see THE OWNER CHECK)
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { HOST_SESSION_HEADER, isBillingReadOnly, isProjectNotEnabled, NO_SESSION_ERROR, projectIdentity, readDeviceCredential, resolveHub, resolveNamedAgent, RESOLVE_ONLY_HEADER, SESSION_HEADER } from "./opencadre-config.mjs";
import { isPureAck } from "./pure-ack.mjs";
import { foreignHost, silenceFor } from "./opencadre-hook-dialect.mjs";

const args = process.argv.slice(2);
const REWAKE = args.includes("--rewake");
// An UNATTENDED Claude Code run (`claude -p`, the SDK) has no idle chat to wake: it ends when its turn ends. Measured on
// claude 2.1.277 (scripts/dev/claude-live-smoke.ts --probe-wake, 2026-09-26): with this watcher long-polling a live hub, a
// `claude -p` turn never exited (killed at 120 s, no output); the same turn without it exited in 3 s. Claude sets
// CLAUDE_CODE_SESSION_ATTENDED=0 for such runs (and 1 in an interactive chat, measured in the desktop app), so the
// watcher leaves at once there, before reading anything or contacting the hub.
if (REWAKE && process.env.CLAUDE_CODE_SESSION_ATTENDED === "0") process.exit(0);
const CODEX_QUEUE = args.includes("--codex-queue");
const client = args.includes("--client") ? args[args.indexOf("--client") + 1] : undefined;
const STDIN_WAIT_MS = 1500;

/** A Stop hook gets its hook JSON (session_id, cwd) on stdin. Read with a short limit: a watcher started any
 * other way may have a stdin that never closes. */
function readHookInput() {
  if ((!REWAKE && !CODEX_QUEUE) || process.stdin.isTTY) return Promise.resolve({});
  return new Promise((done) => {
    let raw = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.destroy();
      try {
        const parsed = JSON.parse(raw || "{}");
        done(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        done({});
      }
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// On a connected machine the session decides the identity, so the hook input is read only when a device credential could
// apply (no named agent for this folder). Without a session id (from the hook or CLAUDE_CODE_SESSION_ID) it stays silent.
const needsSession = !resolveNamedAgent({ client }).key && [client ?? "antigravity"].flat().some((name) => readDeviceCredential({ client: name }));
// A hook launch always reads its payload now, named agent or not: the payload is also how a watcher learns it
// was launched by a harness it was not installed for (below). A NAMED agent still ignores what it says otherwise
// (its folder stays this process's own), exactly as before the payload was read for it.
const payload = needsSession || REWAKE || CODEX_QUEUE ? await readHookInput() : {};
// Cursor runs Claude Code's hooks by default but knows nothing of `asyncRewake`, so it would run this
// watcher IN THE FOREGROUND of a Cursor chat's stop, for up to the seven-day hook timeout, as a Claude Code
// session. A watcher launched by a foreign harness exits at once. Cursor reads an empty answer as a failed run,
// so it is given the host's own "no opinion".
const host = (REWAKE || CODEX_QUEUE) ? foreignHost(client ?? "claude-code", payload) : null;
if (host) {
  const quiet = silenceFor(host);
  if (quiet) process.stdout.write(quiet);
  process.exit(0);
}
const hookInput = needsSession || CODEX_QUEUE ? payload : {};
const codexThread = CODEX_QUEUE && typeof hookInput.session_id === "string" ? hookInput.session_id : null;
// A Stop hook supplies the thread UUID. Keep it out of any Windows shell unless it is exactly a UUID.
if (CODEX_QUEUE && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codexThread ?? "")) process.exit(0);
const CWD = typeof hookInput.cwd === "string" ? hookInput.cwd : process.cwd();
// Launched by an Antigravity conversation as a background task (no hook input): agy puts the conversation's id in every
// command's environment (measured on 1.2.9), so a connected computer's watcher waits for THAT conversation's mail.
const antigravityConversation = (client ?? "antigravity") === "antigravity" && typeof process.env.ANTIGRAVITY_CONVERSATION_ID === "string" && process.env.ANTIGRAVITY_CONVERSATION_ID
  ? process.env.ANTIGRAVITY_CONVERSATION_ID : undefined;
const hookSession = typeof hookInput.session_id === "string" ? hookInput.session_id : undefined;
const resolveIdentity = () => resolveHub({
  client: !hookSession && antigravityConversation && !client ? "antigravity" : client,
  cwd: CWD,
  sessionId: hookSession ?? antigravityConversation,
});
let { base: BASE, key: KEY, headers: SESSION_HEADERS = {} } = resolveIdentity();
// A named agent is one identity everywhere; only a session's identity depends on the folder's project.
const projectBound = SESSION_HEADERS[SESSION_HEADER] !== undefined;
const currentProject = () => (projectBound ? projectIdentity(CWD)?.key ?? null : null);
let project = currentProject();
const WAIT_SECONDS = Number(process.env.OPENCADRE_WAIT_SECONDS || 50);
const MAX_FAILURES = Number(process.env.OPENCADRE_WAKE_MAX_FAILURES || 20);
const RETRY_MS = Number(process.env.OPENCADRE_WAKE_RETRY_MS || 5000);
const MAX_BACKOFF_MS = 30000;
const PREVIEW_CHARS = 120;
// A persisted, per-seat cooldown that COALESCES. Measured (lane 9, n=213): one wake re-reads a median
// 497k tokens, because it lands on a session that has been running for hours, and the cost sits in
// per-wake context size rather than wake count. So the point is not to space wakes apart but to turn N
// wakes into one wake carrying all N messages: while the cooldown runs, real mail is held in memory and
// the cursor is NOT advanced, so the wake that ends the hold carries everything held. A watcher that
// dies mid-hold loses nothing, because the mail is still unread behind the unmoved cursor.
const COOLDOWN_MS = Math.max(0, Number(process.env.OPENCADRE_WAKE_COOLDOWN_SECONDS || 120)) * 1000;
// Claude Code shows an asyncRewake hook's stderr to the agent when it exits 2.
// Silent once the owner check found the chat gone: nobody reads this stderr any more.
const say = (...line) => {
  if (!ownerGone) (REWAKE ? console.error : console.log)(...line);
};
// Exit 2 under --rewake is the wake signal itself, so it is used ONLY for a delivered wake. An error ends a hook with exit 1
// (reportOnce): non-fatal, and no wake.
const WAKE_CODE = REWAKE ? 2 : 0;

if (!BASE || !KEY) {
  if (REWAKE || CODEX_QUEUE) process.exit(0);
  console.log("OPENCADRE WAKE ERROR: set OPENCADRE_URL and OPENCADRE_KEY");
  process.exit(1);
}

// One cursor and one lock per agent, without ever writing the key itself to disk. A device credential serves many
// sessions, so its hash also covers the session's seat (the host session id, else the tool session id): the same agent
// the hub resolves, so two sessions on one machine never share a cursor, and /clear keeps its own.
const stateDir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre");
const seat = SESSION_HEADERS[HOST_SESSION_HEADER] || SESSION_HEADERS[SESSION_HEADER];
const keyHash = createHash("sha256").update(CODEX_QUEUE ? `${KEY}\n${codexThread}` : seat ? `${KEY}\n${seat}` : KEY).digest("hex").slice(0, 16);
const stateFile = join(stateDir, `wake-${keyHash}.json`);
// The synchronous awareness Stop hook writes the exact ids it delivered. Its state directory defaults
// to the OS temp dir, and both hooks use the same key+thread hash without putting a credential on disk.
const deliveredFile = join(process.env.OPENCADRE_AWARENESS_STATE_DIR || tmpdir(), `opencadre-stop-delivered-${keyHash}.json`);
const lockFile = join(stateDir, `wake-${keyHash}.lock`);
// One JSON line per wake, per seat. The cursor file cannot carry this: it holds only the LAST wake
// (`lastWakeAt` is overwritten every time) and nothing else on disk records a wake at all, which made
// R6's metric -- wakes per agent-hour (RELIABILITY_SPRINT.md) -- unmeasurable rather than unmeasured.
// Append-only and per-seat, so two seats never contend for one file.
const historyFile = join(stateDir, `wake-history-${keyHash}.jsonl`);
/** Rolling cap. A wake per cooldown at worst is 30/h, so 5000 lines is about a week: long enough to
 * read a daily rate off, and it keeps the file near 275 kB. The trim is gated on SIZE rather than
 * line count so the common path stays one append and one stat, never a whole-file rewrite. */
const HISTORY_MAX_LINES = 5000;
const HISTORY_MAX_BYTES = 512 * 1024;

// Every Stop starts another watcher, so without this lock idle watchers would pile
// up and each would wake the agent for the same mail. The owner touches the lock after every
// poll; one untouched for twice a full poll plus the longest backoff belongs to a dead or suspended
// watcher, even if Windows has since reused its pid.
//
// OWNERSHIP IS A TOKEN, NOT A PID. The lock carries a random `nonce` only its writer knows; this watcher owns the seat only
// while the lock holds ITS nonce. A pid alone cannot say that: Windows reuses pids (2026-10-01: two wake locks named pids
// svchost.exe held).
//
// EVERY SEAT WRITE AND EVERY DELIVERY HAPPENS UNDER THE SEAT'S CLAIM (withSeat). The claim is exclusive: claims live in
// wake-<hash>.claims/ as numbered files, and claim n is taken by creating file <n> exclusively (a hard link of a finished
// temp file, so it is never seen half-written), which is allowed only when claim n-1 is released (<n-1>.done, written by
// its holder as its last act) or its holder is PROVEN gone (its pid is not running, or that pid is now a process created
// after the holder started). Nothing ever removes or rewrites a claim another watcher may hold: recovering an abandoned
// claim creates the NEXT number, so a successor's live claim cannot be removed or invalidated, and two watchers recovering
// the same abandoned claim cannot both win (one exclusive create). Only numbers more than one below the newest are swept,
// and every holder's claim is necessarily the newest (no successor number can exist while it is live and unreleased).
// A holder suspended or stuck while holding the claim is never recovered from (its pid is alive): the seat then DEFERS.
//
// Under the claim the owner re-reads the lock: its own nonce means no takeover has happened, and none can until it
// releases the claim, because taking a stale lock over also needs the claim. So, holding it, the owner:
//   - writes the cursor and cooldown clock (wake-<hash>.json) and the wake history;
//   - delivers a wake: a Codex queue runs while the claim is held, and is recorded only once it succeeded; an exit-2 wake
//     records the cursor past the mail BEFORE the claim is released, so a successor that takes over afterwards loads that
//     cursor and never wakes for the same mail again, while one that took over before finds the lock is not ours, and we
//     neither write nor wake.
// When ownership cannot be established (the claim is busy, or cannot be made), nothing is written and nothing delivered:
// the mail stays pending in memory behind the old saved cursor and is retried after the next poll; if this watcher dies
// meanwhile, the mail is still unread behind that cursor for the next one. There is no unguarded fallback and no
// lock-less mode: a lock, claim or lock read that fails for any reason but a busy holder means no seat here, and a seat
// that stays unusable (a state dir that is a file, unwritable or unreadable) is reported on stderr and left (unusable).
//
// An older watcher (before tokens) knows neither the nonce nor the claim. It reads only `pid` from this lock, so a new
// watcher's fresh lock makes it leave, and it releases by pid, which cannot match a live successor's. But it takes over a
// lock it judges stale without the claim, so against an older watcher the guarantees above hold only while the new owner
// keeps its lock fresh (a new owner suspended for longer than STALE_MS can overlap an old one, as before this change).
//
// The lock also records this process's own start (`procStart`, from Node's uptime: the process INCARNATION, which the
// OS creation time must match) beside the lock's write time (`startedAt`, wall time, only an upper bound on the start),
// so `connect --upgrade` can tell this watcher from a later process that reused its pid (cli/lib/generations.mjs
// judgeRecordedPid), plus its `role` and whether it runs the owner check below (`ownerCheck`).
const STALE_MS = 2 * ((WAIT_SECONDS + 20) * 1000 + MAX_BACKOFF_MS);
const NONCE = randomBytes(12).toString("hex");
const PROC_START = Math.round(Date.now() - process.uptime() * 1000);
const claimsDir = join(stateDir, `wake-${keyHash}.claims`);
/** Only a claim held at least this long has its holder's incarnation checked (one process query, so never on a busy
 * claim's normal path). OPENCADRE_WAKE_CLAIM_STALE_MS shortens it in tests. */
const CLAIM_STALE_MS = Math.max(100, Number(process.env.OPENCADRE_WAKE_CLAIM_STALE_MS) || 10_000);
// THE OWNER CHECK (Claude Code asyncRewake). The wake is delivered through this process's exit code and stderr, read by
// the process that ran the Stop hook, which holds the read end of the stderr pipe. When that process is gone, the OS
// closes that end and nothing can ever deliver this watcher's wake (on Windows the hook's bash and this watcher keep
// running: measured 2026-10-01, two such watchers counted as live for days). A zero-byte write to stderr then fails with
// EPIPE, and writes nothing while the reader is there, so the watcher probes it every OPENCADRE_WAKE_OWNER_CHECK_MS and
// leaves, silently, when it fails. Only EPIPE counts as gone; anything else is unknown, and the watcher stays.
// What this does NOT cover, and does not claim to:
//   - that a real Claude Code gives the hook a stderr PIPE is inferred, not measured on an install (the lock's
//     `ownerCheck` says whether this watcher found one);
//   - Linux: a zero-byte write to a pipe with no reader returns 0 there, so the check never fires;
//   - a pooled host (one process serving several chats) keeps the pipe open after a chat closes;
//   - /clear without the keeper session id leaves the previous seat's watcher on the same open pipe;
//   - the hub: this watcher's own long-poll counts as its session's heartbeat, so the hub's idle TTL cannot end a session
//     whose watcher is still polling (filed separately).
const OWNER_CHECK = REWAKE && process.stderr._type === "pipe" ? "stderr-pipe" : "none";
const OWNER_CHECK_MS = Math.max(50, Number(process.env.OPENCADRE_WAKE_OWNER_CHECK_MS) || 15_000);
let ownerGone = false;
const readLock = () => {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A test seam, inert unless OPENCADRE_WAKE_TEST_GATES names a folder: at a named point, while <folder>/<name>.hold
// exists, the watcher records <name>.reached and waits. Tests use it to put another actor's move at an exact point.
const GATES = process.env.OPENCADRE_WAKE_TEST_GATES || null;
function gate(name) {
  if (!GATES || !existsSync(join(GATES, `${name}.hold`))) return;
  try {
    writeFileSync(join(GATES, `${name}.reached`), String(process.pid));
  } catch { /* the test sees it did not arrive */ }
  const until = Date.now() + 60_000;
  while (existsSync(join(GATES, `${name}.hold`)) && Date.now() < until) pause(10);
}
// A second test seam, inert unless OPENCADRE_WAKE_TEST_FAULTS lists point:CODE pairs (lock-create, lock-read,
// claim-create): that operation then fails with that error code, as an unwritable or unreadable folder would.
const FAULTS = new Map((process.env.OPENCADRE_WAKE_TEST_FAULTS || "").split(",").filter(Boolean).map((p) => p.split(":")));
// `point:CODE*N` fails only the first N times (a transient error).
const faultCounts = new Map();
function fault(point) {
  const spec = FAULTS.get(point);
  if (!spec) return;
  const [code, times] = spec.split("*");
  const n = (faultCounts.get(point) ?? 0) + 1;
  faultCounts.set(point, n);
  if (times === undefined || n <= Number(times)) throw Object.assign(new Error(`${code}: injected at ${point}`), { code });
}
/** Test seam: with OPENCADRE_WAKE_TEST_GATES set, records one line per traced step in <gates>/trace.log (claim creates). */
function trace(line) {
  if (!GATES) return;
  try {
    appendFileSync(join(GATES, "trace.log"), `${line}
`);
  } catch { /* the test sees it missing */ }
}
/** Whether two parsed locks are the same lock: by nonce, or, for a lock from before nonces, by pid and startedAt. */
const sameLock = (a, b) => Boolean(a && b) && (a.nonce || b.nonce ? a.nonce === b.nonce : a.pid === b.pid && a.startedAt === b.startedAt);

const claimPath = (name) => join(claimsDir, String(name));
// Reads in the claim code keep their errors TYPED (review of #694 at eb9fc6b1): a listing or a read that fails is not
// "no claims" or "no holder". Only ENOENT means absent; anything else is an error that defers the seat and, if it keeps
// failing, reports it (reportOnce "state"). A denied listing read as empty made the watcher re-create a claim that
// exists, forever.
/** The claim numbers present: { numbers } ([] only when the folder does not exist yet), or { error }. */
const claimNumbers = () => {
  try {
    fault("claim-list");
    const names = readdirSync(claimsDir);
    // Test seam: a listing that omits what is there (as a broken filesystem might), to prove the retry is bounded.
    if (FAULTS.get("claim-list-omits") === "all") return { numbers: [] };
    return { numbers: names.filter((n) => /^\d+$/.test(n)).map(Number) };
  } catch (err) {
    if (err?.code === "ENOENT") return { numbers: [] };
    return { error: err?.code || "claim list failed" };
  }
};
/** Claim `n`: { claim }, { missing } (swept or released meanwhile), { unparseable } (being written), or { error }. */
const readClaim = (n) => {
  try {
    fault("claim-read");
    return { claim: JSON.parse(readFileSync(claimPath(n), "utf8")) };
  } catch (err) {
    if (err?.code === "ENOENT") return { missing: true };
    if (err instanceof SyntaxError) return { unparseable: true };
    return { error: err?.code || "claim read failed" };
  }
};
/** Creates `file` holding `text` only if it does not exist; true when this call created it. Never replaces a file. */
function createExclusive(file, text) {
  fault("claim-create");
  trace(`create ${basename(file)}`);
  if (FAULTS.get("claim-create-loses") === "all" && /^\d+$/.test(basename(file))) {
    writeFileSync(file, JSON.stringify({ nonce: "churn", pid: 2147483646, procStart: 0 })); // another watcher won it, then died
    return false;
  }
  const tmp = join(claimsDir, `.tmp-${NONCE}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"].includes(err.code)) throw err;
    // No hard links on this volume: an exclusive create, then the text (a reader that finds it empty treats it as busy).
    try {
      writeFileSync(file, text, { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
/** When the process `pid` was created, from the OS; null when it cannot be read. Asked only about a long-held claim,
 * and remembered for 30 s, so a wait on one claim costs one process query, not one per retry. */
const creationTimes = new Map();
function creationTime(pid) {
  if (FAULTS.get("creation-time") === "unknown") return null; // test seam: the process query cannot say
  const known = creationTimes.get(pid);
  if (known && Date.now() - known.at < 30_000) return known.value;
  const value = readCreationTime(pid);
  creationTimes.set(pid, { at: Date.now(), value });
  return value;
}
function readCreationTime(pid) {
  try {
    if (process.platform === "win32") {
      const ps = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}";if($p){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}`], { encoding: "utf8", timeout: 8000, windowsHide: true });
      const ms = Number(String(r.stdout ?? "").trim());
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
    const ms = Date.parse(String(r.stdout ?? "").trim().replace(/\s+/g, " "));
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
/** Whether claim `n` may be followed: "free" (released, or its holder PROVEN gone: its pid not running, or its pid now a
 * process created after the holder started, or long before it), "held" (a holder that is alive, unreadable-but-present,
 * or not provably gone), "gone" (the claim vanished meanwhile: list again), or { error } (it cannot be read here). */
function claimState(n) {
  try {
    statSync(claimPath(`${n}.done`));
    return "free";
  } catch (err) {
    if (err?.code !== "ENOENT") return { error: err?.code || "claim stat failed" };
  }
  const read = readClaim(n);
  if (read.error) return { error: read.error };
  if (read.missing) return "gone";
  const holder = read.claim;
  if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0) return "held";
  if (holder.pid === process.pid) return holder.nonce !== NONCE ? "free" : "held"; // our own pid, another nonce: an earlier process
  if (!alive(holder.pid)) return "free";
  let age = 0;
  try {
    age = Date.now() - statSync(claimPath(n)).mtimeMs;
  } catch (err) {
    return err?.code === "ENOENT" ? "gone" : { error: err?.code || "claim stat failed" };
  }
  if (age < CLAIM_STALE_MS || !Number.isFinite(holder.procStart)) return "held";
  const created = creationTime(holder.pid);
  // Node's own start is a little after the OS creation, and no Node start comes two minutes after it. The 30 s margin
  // on the other side absorbs a wall-clock step; a reuse inside it is not provable, and the seat defers.
  return created !== null && (created > holder.procStart + 30_000 || created < holder.procStart - 120_000) ? "free" : "held";
}
/** How often in a row the listing may fail to show a claim this watcher just found already there, before that is an error. */
const CLAIM_LIST_STALLS = 3;
/** The most exclusive creates one acquisition tries; past it (or past its deadline) the seat is busy: defer. */
const CLAIM_CREATES_MAX = 50;
/** Takes this seat's claim: the next number, created exclusively, after a released or proven-abandoned one. Waits up to
 * `waitMs` while a live holder has it. Returns { n } (the claim number), { busy: true } (a live holder has it: defer), or
 * { error } (the claims cannot be listed, read or made here: defer, and the caller reports a seat that stays unusable).
 * Bounded on every path: the wait ends at its deadline, and a lost race (the number already exists) must show up in the
 * next listing, or after CLAIM_LIST_STALLS listings that do not show it, it is an error, never an endless retry. */
function acquireClaim(waitMs) {
  try {
    mkdirSync(claimsDir, { recursive: true });
  } catch (err) {
    return { error: err.code || "mkdir failed" };
  }
  const until = Date.now() + waitMs;
  let lost = -1; // the highest number found already taken by an exclusive create
  let stalls = 0;
  let tries = 0;
  for (;;) {
    const listed = claimNumbers();
    if (listed.error) return { error: listed.error };
    const top = listed.numbers.length ? Math.max(...listed.numbers) : -1;
    if (top < lost) {
      // The listing does not show a claim that exists: no progress is possible from it.
      if (++stalls >= CLAIM_LIST_STALLS) return { error: `claim list does not show claim ${lost}` };
    } else stalls = 0;
    const state = top < 0 ? "free" : claimState(top);
    if (state.error) return { error: state.error };
    if (state === "free") {
      if (top >= 0) gate("claim-next");
      if (++tries > CLAIM_CREATES_MAX) return { busy: true };
      let made;
      try {
        made = createExclusive(claimPath(top + 1), JSON.stringify({ nonce: NONCE, pid: process.pid, procStart: PROC_START }));
      } catch (err) {
        return { error: err.code || "create failed" };
      }
      if (made) {
        // A watcher that read the claims long ago may have re-created a number already swept: only the newest counts.
        const after = claimNumbers();
        if (after.error) {
          releaseClaim(top + 1);
          return { error: after.error };
        }
        if (Math.max(...after.numbers) !== top + 1) return { busy: true };
        sweepClaims(top + 1);
        return { n: top + 1 };
      }
      lost = Math.max(lost, top + 1); // another watcher took that number: it must show in the next listing
    } else if (state !== "gone") {
      pause(20);
    }
    // Every path, a lost race included, ends at the deadline: contention that never settles defers, it never spins.
    if (Date.now() >= until) return { busy: true };
  }
}
function releaseClaim(n) {
  try {
    createExclusive(claimPath(`${n}.done`), "");
  } catch { /* unreleased: it is freed once this process has exited */ }
}
/** Removes claims more than one below `n` (their holders released them or are gone: claim n exists) and old temp files. */
function sweepClaims(n) {
  try {
    for (const name of readdirSync(claimsDir)) {
      const m = /^(\d+)(\.done)?$/.exec(name);
      if (m && Number(m[1]) < n - 1) rmSync(claimPath(name), { force: true });
      else if (name.startsWith(".tmp-") && Date.now() - statSync(claimPath(name)).mtimeMs > 60_000) rmSync(claimPath(name), { force: true });
    }
  } catch { /* best effort, never destructive: what cannot be listed or removed is swept next time */ }
}
/** The lock as it is now: { lock }, { missing } (removed: another watcher's move), { unparseable } (another watcher's lock
 * being written, or a damaged one), or { error } (it cannot be read here: ownership cannot be established). `point` names
 * the read for the fault seam. */
const readLockState = (point = "lock-read") => {
  try {
    fault(point);
    return { lock: JSON.parse(readFileSync(lockFile, "utf8")) };
  } catch (err) {
    if (err?.code === "ENOENT") return { missing: true };
    if (err instanceof SyntaxError) return { unparseable: true };
    return { error: err?.code || "read failed" };
  }
};
/** Why the last withSeat deferred: "busy" (a live holder has the claim) or an error code (the seat cannot be used here). */
let deferredFor = null;
/** Runs `fn` as this seat's owner: holding the claim, with the lock still holding this watcher's nonce. Returns "done",
 * "superseded" (another watcher owns the seat: nothing ran) or "deferred" (ownership could not be established, for ANY
 * reason, a busy claim or an error: nothing ran; try later). Seat state is never written, and a wake never delivered,
 * outside it: there is no unlocked mode. */
function withSeat(fn, waitMs = 1000) {
  gate("seat-wanted");
  const claim = acquireClaim(waitMs);
  if (claim.n === undefined) {
    deferredFor = claim.error ?? "busy";
    trace(`deferred ${deferredFor}`);
    return "deferred";
  }
  try {
    const now = readLockState();
    if (now.error) {
      deferredFor = now.error;
      return "deferred";
    }
    if (now.lock?.nonce !== NONCE) return "superseded";
    gate("seat-owned");
    fn();
    deferredFor = null;
    return "done";
  } finally {
    releaseClaim(claim.n);
  }
}
/** Reports an error that delivers nothing, as the client's non-fatal hook failure: the line goes to stderr (stdout for a
 * plain background task, whose output is what it shows), and the result is the exit code to use, 1. Exit 2 is never used:
 * under --rewake it is the wake signal, and an error must not wake an idle agent at every turn end. A hook (--rewake,
 * --codex-queue) runs again at every turn end, so a hook reports each error CLASS once a day per seat and `scope` (a flag
 * in the OS temp dir, made exclusively, so concurrent hooks report once); a run that finds it already reported returns 0
 * and stays silent. Classes are separate: a state-folder problem never hides a hub outage, nor the reverse. A plain
 * background task is relaunched by the agent itself, so it reports every time. */
function reportOnce(errorClass, scope, line) {
  let report = true;
  if (REWAKE || CODEX_QUEUE) {
    const flag = join(tmpdir(), `opencadre-wake-${errorClass}-${keyHash}-${createHash("sha256").update(String(scope)).digest("hex").slice(0, 8)}.flag`);
    try {
      if (Date.now() - statSync(flag).mtimeMs < 24 * 3600_000) report = false;
      else rmSync(flag, { force: true });
    } catch { /* no flag yet */ }
    if (report) {
      try {
        writeFileSync(flag, line, { flag: "wx" });
      } catch (err) {
        if (err.code === "EEXIST") report = false; // a concurrent run reported it
      }
    }
  }
  if (!report) return 0;
  try {
    writeSync(REWAKE || CODEX_QUEUE ? 2 : 1, `${line}\n`);
  } catch { /* nobody is reading */ }
  return 1;
}
/** A seat whose state cannot be used here (the state dir is a file, unwritable, unreadable...) delivers nothing, ever, so
 * it must not be silent: reported (reportOnce, class "state", per folder), then the watcher leaves. The mail stays unread
 * for a watcher that can use its state. */
function unusable(reason) {
  process.exit(reportOnce("state", stateDir, `OPENCADRE WAKE ERROR: this agent's wake state in ${stateDir} cannot be used (${reason}), so no wake was delivered and the mail stays unread. Make that folder a writable directory, or point OPENCADRE_WAKE_STATE_DIR at one.`));
}
function takeLock() {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch { /* the write below reports it */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fault("lock-create");
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, nonce: NONCE, startedAt: Date.now(), procStart: PROC_START, role: "opencadre-wake", ownerCheck: OWNER_CHECK }), { flag: "wx" });
      return "locked";
    } catch (err) {
      // Any other failure means no lock can be had here: never run without one (no seat, no delivery).
      if (err.code !== "EEXIST") return { error: err.code || "lock create failed" };
    }
    let age;
    try {
      age = Date.now() - statSync(lockFile).mtimeMs;
    } catch (err) {
      if (err.code === "ENOENT") continue; // removed meanwhile: retry
      return { error: err.code || "lock stat failed" };
    }
    const found = readLockState();
    if (found.error) return { error: found.error };
    const owner = found.lock ?? null;
    // An unparseable fresh lock is one being written right now.
    if (age < STALE_MS && (!owner || alive(owner.pid))) return "held";
    // Stale: replace it holding the claim, and only if it is still the lock judged stale. A busy claim: leave it be.
    gate("takeover-judged");
    const claim = acquireClaim(1000);
    if (claim.error) return { error: claim.error };
    if (claim.n === undefined) return "held";
    try {
      // Re-judged under the claim, from what is there NOW (review of #694 at 7012c8d3): a lock that cannot be read is not
      // "no lock" (a successor's may be there), so a read error defers and is reported, and nothing is removed. Removed
      // only if it is still the very lock judged stale (an unparseable one only while it is still old: a successor's lock
      // being written is new), and still stale.
      const now = readLockState("takeover-reread");
      if (now.error) return { error: now.error };
      let age = 0;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
      } catch (err) {
        if (err.code !== "ENOENT") return { error: err.code || "lock stat failed" };
      }
      const same = owner ? Boolean(now.lock) && sameLock(now.lock, owner) : Boolean(now.unparseable);
      if (same && (age >= STALE_MS || (owner && !alive(owner.pid)))) rmSync(lockFile, { force: true });
    } finally {
      releaseClaim(claim.n);
    }
  }
  return "held";
}

const taken = takeLock();
if (taken === "held") process.exit(0);
if (taken !== "locked") unusable(taken.error);
const ownsLock = () => readLock()?.nonce === NONCE;
/** Error deferrals in a row. A seat that keeps failing (its claim or lock cannot be made or read) is reported and left. */
let seatErrors = 0;
const SEAT_ERRORS_BEFORE_REPORT = 3;
/** withSeat for the watcher's own work: an error deferral is counted, and a seat that keeps failing is reported. */
function asSeat(fn) {
  const outcome = withSeat(fn);
  if (outcome !== "deferred" || deferredFor === "busy") seatErrors = 0;
  else if (++seatErrors >= SEAT_ERRORS_BEFORE_REPORT) unusable(deferredFor);
  return outcome;
}
process.on("exit", () => {
  // Released only as the owner; otherwise left for its pid, which is gone now, to mark it stale.
  withSeat(() => rmSync(lockFile, { force: true }), 200);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
const heartbeat = () => {
  if (!ownsLock()) return false;
  try {
    const now = new Date();
    utimesSync(lockFile, now, now);
  } catch { /* checked again after the next poll */ }
  return true;
};
if (OWNER_CHECK === "stderr-pipe") {
  const probe = () => {
    try {
      writeSync(2, "");
    } catch (err) {
      if (err?.code !== "EPIPE") return; // unknown is not gone
      clearInterval(ownerTimer);
      ownerGone = true;
      // finish(0), spelled out: this can run before `finish` is defined below. The exit handler releases the lock.
      setTimeout(() => process.exit(0), 20);
    }
  };
  const ownerTimer = setInterval(probe, OWNER_CHECK_MS);
  ownerTimer.unref();
  probe();
}

let afterId = "";
let lastWakeAt = 0;
try {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  // A cursor saved for another project's agent points into another inbox (a file from before projects has none).
  if (saved.project === undefined || saved.project === project) {
    afterId = saved.afterId ?? "";
    lastWakeAt = Number(saved.lastWakeAt) || 0;
  }
} catch { /* first run: consider all unread mail */ }

// The cursor and the cooldown clock belong to whichever watcher owns the seat now. writeCursor and recordHistory write
// them as they are; they run only inside withSeat. saveCursor is the guarded form: superseded or deferred, it writes
// nothing, and the old cursor stays (mail behind it is only examined again).
const writeCursor = () => {
  try {
    mkdirSync(stateDir, { recursive: true });
    // lastWakeAt rides along so the cooldown is per seat and survives the relaunch on every Stop. An
    // older watcher ignores the extra field, so this stays readable in both directions.
    const state = projectBound ? { afterId, project, lastWakeAt } : { afterId, lastWakeAt };
    writeFileSync(stateFile, JSON.stringify(state));
  } catch { /* worst case a relaunch re-wakes once */ }
};
const saveCursor = () => asSeat(writeCursor);

/** Appends one wake to the history. `n` is how many messages this wake carried (1 = the cooldown had
 * nothing to coalesce with) and `urgent` is whether a question or a high-priority message ended a hold
 * early -- so the log says whether the cooldown is actually coalescing or being bypassed. Best-effort:
 * a history that cannot be written must never cost a wake, the same rule as saveCursor. */
const recordHistory = (n, urgent) => {
  try {
    mkdirSync(stateDir, { recursive: true });
    // Trim only once the file outgrows the cap. The wake path itself stays one append, so a history
    // that is never read costs the wake nothing but a write.
    try {
      if (statSync(historyFile).size > HISTORY_MAX_BYTES) {
        const kept = readFileSync(historyFile, "utf8").split("\n").filter(Boolean).slice(-HISTORY_MAX_LINES);
        writeFileSync(historyFile, kept.length ? `${kept.join("\n")}\n` : "");
      }
    } catch { /* no file yet: the append below creates it */ }
    appendFileSync(historyFile, `${JSON.stringify({ t: new Date().toISOString(), n, urgent })}\n`);
  } catch { /* the metric is lost, never the wake */ }
};

/** The ONE place a wake is recorded, so no future wake site can forget the history. Every wake does
 * both: move the cooldown clock (the cursor carries it) and log the wake. Runs only inside withSeat (deliverWake). */
const recordWake = (n, urgent) => {
  lastWakeAt = Date.now();
  writeCursor();
  recordHistory(n, urgent);
};
// On Windows Codex is either a native executable or an npm shim whose own target is
// node_modules/@openai/codex/bin/codex.js next to the shim. Resolve that target through PATH
// and keep argv in an array; cmd.exe/PowerShell would reparse the notice.
function codexLauncher() {
  if (process.platform !== "win32") return { command: "codex", prefix: [] };
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const native = join(dir, "codex.exe");
    if (existsSync(native)) return { command: native, prefix: [] };
    const shim = join(dir, "codex.cmd");
    const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(shim) && existsSync(entry)) {
      // npm's .cmd shim prefers the node.exe in its own directory. That Node's architecture
      // matches Codex's installed native package even if a different Node launched this hook.
      const adjacentNode = join(dir, "node.exe");
      return { command: existsSync(adjacentNode) ? adjacentNode : process.execPath, prefix: [entry] };
    }
  }
  return null;
}

// Codex queue writes to the existing TUI thread. A failed queue must leave the saved cursor behind
// this mail so the next Stop can retry; the watcher never consumes inbox messages.
//
// The delivery itself happens as the seat's owner (withSeat), never after a check that has already let go: a Codex queue
// runs while the claim is held, and an exit-2 wake is recorded (the cursor moved past this mail) before the claim is
// released, so a successor can never wake for the same mail. Returns "deferred" when ownership could not be established:
// nothing was delivered or written, and the caller keeps the mail pending.
function deliverWake(waking, urgent) {
  if (ownerGone) {
    finish(0);
    return "done";
  }
  let failed = null;
  const outcome = asSeat(() => {
    if (CODEX_QUEUE) {
      gate("deliver-codex");
      const notice = `You have ${waking.length} unread OpenCadre message(s). Use "get_messages" to read them and answer each on its thread.`;
      const launcher = codexLauncher();
      if (!launcher) {
        failed = "OPENCADRE WAKE ERROR: Codex CLI launcher was not found on PATH.";
        return;
      }
      const queued = spawnSync(launcher.command, [...launcher.prefix, "queue", "--thread", codexThread, "--message", notice], {
        windowsHide: true, timeout: 15000, encoding: "utf8", shell: false,
      });
      if (queued.error || queued.status !== 0) {
        failed = `OPENCADRE WAKE ERROR: codex queue failed (${queued.error?.message ?? queued.stderr?.trim() ?? queued.status}).`;
        return;
      }
    }
    recordWake(waking.length, urgent);
  });
  if (outcome === "deferred") return "deferred";
  // Superseded: the seat is another watcher's, and so is this mail (still unread behind its cursor).
  if (outcome === "superseded") {
    finish(0);
    return "done";
  }
  if (failed) {
    console.error(failed);
    finish(1);
    return "done";
  }
  if (!CODEX_QUEUE) {
    const next = REWAKE ? "Read them with get_messages and answer each on its thread." : "Read them with get_messages, answer each on its thread, then relaunch this watcher.";
    say(`OPENCADRE WAKE: ${waking.length} new message(s). ${next}`);
    for (const m of waking) say(`- [${m.priority}] from ${m.from_agent_name}: ${preview(m.body)}`);
  }
  finish(WAKE_CODE);
}

const wakes = (m) => m.priority !== "low" && (m.awaiting_reply || !isPureAck(m.body));
// What ends a hold early. `high` is the obvious one; an awaited question is the other, and it is the
// sprint's own requirement ("a question still wakes promptly"). A question is addressed work, not the
// agent-to-agent ping-pong the cooldown exists to damp, so the cooldown must not sit on it. (9d1f.)
const urgentEnough = (m) => m.priority === "high" || m.priority === "urgent" || Boolean(m.awaiting_reply);
const preview = (s) => (s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s).replace(/\s+/g, " ");

// On Windows, process.exit() while a timer handle is still closing can trip a libuv
// assertion (reported live by Antigravity). The request timer is cleared manually
// instead of via AbortSignal.timeout, and exit waits one short tick.
const finish = (code) => setTimeout(() => process.exit(code), 20);

let failures = 0;
let firstMailBatch = true;
const deliveredIds = () => {
  try { return new Set(JSON.parse(readFileSync(deliveredFile, "utf8")).ids); }
  catch { return new Set(); }
};
// The two Stop handlers can start concurrently. Give awareness a short window to publish its exact
// handoff before the first nonempty poll is classified. A missing handoff wakes conservatively.
const stopDelivered = async (messages) => {
  if (!CODEX_QUEUE || hookInput.stop_hook_active !== false) return new Set();
  let ids = deliveredIds();
  if (firstMailBatch) {
    firstMailBatch = false;
    for (let i = 0; i < 20 && !messages.some((m) => ids.has(m.id)); i++) {
      await new Promise((done) => setTimeout(done, 50));
      ids = deliveredIds();
    }
  }
  return ids;
};
// Real messages held for the coalescing wake. In memory only, by design: the on-disk cursor is left
// behind them, so dying here loses nothing. Ids are tracked so a poll that returns an overlap cannot
// list the same message twice.
const held = [];
const heldIds = new Set();
const holdReal = (real) => {
  for (const m of real) {
    if (heldIds.has(m.id)) continue;
    heldIds.add(m.id);
    held.push(m);
  }
};
for (;;) {
  // The chat moved to another project (or its folder's remote changed): that project has its own agent on the hub.
  const nowProject = currentProject();
  if (nowProject !== project) {
    project = nowProject;
    ({ base: BASE, key: KEY, headers: SESSION_HEADERS = {} } = resolveIdentity());
    afterId = "";
    // A different project's inbox is a different seat: its cooldown clock does not carry over.
    lastWakeAt = 0;
    if (!BASE || !KEY) {
      finish(0);
      break;
    }
  }
  // A hold waiting on the clock polls no longer than the cooldown has left, so the hold check below runs when the
  // cooldown ends instead of up to one whole WAIT_SECONDS later (measured 41 s late, 2026-10-09). Floor 1 s, which is
  // also the hub's own minimum (src/service.ts waitForMessage clamps to 1..280). Anything else polls WAIT_SECONDS as
  // before: nothing held, the cooldown off, held mail that is urgent, or a cooldown already over (mail still held
  // then is a deferred wake, which keeps its old retry pace rather than a 1 s loop).
  const holdLeftMs = lastWakeAt + COOLDOWN_MS - Date.now();
  const onTheClock = held.length > 0 && COOLDOWN_MS > 0 && holdLeftMs > 0 && !held.some(urgentEnough);
  const pollSeconds = onTheClock ? Math.max(1, Math.min(WAIT_SECONDS, Math.ceil(holdLeftMs / 1000))) : WAIT_SECONDS;
  const controller = new AbortController();
  const requestTimer = setTimeout(() => controller.abort(new Error("request timed out")), (pollSeconds + 20) * 1000);
  let messages;
  let error;
  try {
    const cursor = afterId ? `&afterId=${encodeURIComponent(afterId)}` : "";
    // A session's watcher is not its chat, and its wait says so. Built from the CURRENT identity: a project switch replaces it.
    // - no-heartbeat: polling is transport, not chat liveness. Without it every poll beat the session on auth and through
    //   the hold, so an orphaned watcher kept its chat online and out of the 12 h idle TTL forever (OpenCode's opt-out, #585).
    // - resolve-only: a STAMPED client's identity carries create headers (resolveHub's ownSeat), and the hub resolves every
    //   device request, so a poll after the TTL would revive the ended row or mint a new one. Only a real chat call may.
    // A named agent has no session, and sends neither.
    const res = await fetch(`${BASE}/v1/messages/wait?peek=true&timeoutSeconds=${pollSeconds}${cursor}`, {
      headers: { authorization: `Bearer ${KEY}`, ...SESSION_HEADERS,
        ...(SESSION_HEADERS[SESSION_HEADER] !== undefined ? { [RESOLVE_ONLY_HEADER]: "1", "x-opencadre-probe": "no-heartbeat" } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const device = SESSION_HEADERS[SESSION_HEADER] !== undefined;
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        noSession: device && ((res.status === 401 && body?.error === NO_SESSION_ERROR) || isProjectNotEnabled(res.status, body)),
        // A lapsed bill is TERMINAL, not transient. Retrying it holds this hook open for the whole
        // backoff schedule on a workspace that cannot answer differently until a human acts -- and the
        // harness runs this hook at every turn end, so that is a wedged editor. #416 §8 item 6.
        billingLapsed: isBillingReadOnly(res.status, body),
      });
    }
    ({ messages } = await res.json());
  } catch (err) {
    error = err;
  }
  clearTimeout(requestTimer);
  // Resolve-only: this chat has no session on the hub (a helper process, or its proxy hasn't started), or its project isn't
  // enabled in the workspace. There is no inbox to watch, and that isn't an error: exit 0 silently; the next Stop tries again.
  if (error?.noSession) {
    finish(0);
    break;
  }
  // Billing lapsed: exit 0 at once, exactly like no-session. There is nothing to watch (the hub serves
  // reads but refuses this workspace's writes) and nothing the user can do from inside their editor, so
  // the hook says nothing and returns. Deliberately NOT the error path below: that one retries with
  // backoff and finally prints a "hub unreachable" line, which would be both wrong (the hub answered)
  // and slow (measured: the test for this hung past its 30 s timeout before the fix).
  if (error?.billingLapsed) {
    finish(0);
    break;
  }
  // Another watcher took over while this one was suspended: leave the mail (and the cursor) to it.
  if (!heartbeat()) {
    finish(0);
    break;
  }
  if (error) {
    failures++;
    if (failures >= MAX_FAILURES) {
      // Not a wake: no turn is queued, the cursor and cooldown stay as they are, and the mail stays unread. Reported once a
      // day per seat and hub as a non-fatal hook error, so a long outage does not wake the agent at every turn end.
      const next = REWAKE ? "Check the hub; the watcher restarts when your turn ends." : "Check the hub, then relaunch this watcher.";
      finish(ownerGone ? 0 : reportOnce("hub", BASE, `OPENCADRE WAKE ERROR: hub unreachable after ${failures} attempts (${error.message}). ${next}`));
      break;
    }
    await new Promise((r) => setTimeout(r, Math.min(RETRY_MS * failures, MAX_BACKOFF_MS)));
    continue;
  }
  failures = 0;
  // A hold must end on the clock, not on the arrival of more mail. Without this the watcher polls
  // forever holding mail that the cooldown already released, because the empty-poll exit below would
  // run first and skip every hold check.
  if (held.length > 0) {
    const urgentHeld = held.some(urgentEnough);
    if (urgentHeld || Date.now() - lastWakeAt >= COOLDOWN_MS) {
      const waking = held.slice();
      held.length = 0;
      heldIds.clear();
      // Deferred: ownership could not be established, so the mail stays pending and is tried again after the next poll.
      if (deliverWake(waking, urgentHeld) === "deferred") {
        holdReal(waking);
        continue;
      }
      break;
    }
  }
  if (messages.length === 0) continue;
  const handedOff = await stopDelivered(messages);
  afterId = messages[messages.length - 1].id;
  const real = messages.filter((m) => !handedOff.has(m.id) && wakes(m));
  if (real.length === 0) {
    // Nothing worth waking for. Advance the cursor so these are not re-examined -- but ONLY when
    // nothing is held. Saving while holding would move the saved cursor PAST held mail, so a watcher
    // killed after this point would lose it: the exact guarantee the hold exists to give. (9d1f.)
    if (held.length === 0) saveCursor();
    continue;
  }
  // Coalescing hold. Inside the cooldown, carry the real messages and keep polling with the in-memory
  // `afterId`, WITHOUT saving the cursor: the mail stays unread behind the saved cursor, so a watcher
  // that dies here loses nothing and its successor wakes for the same messages. `high` ends it at once
  // — the cooldown exists to stop agent-to-agent ping-pong, not to delay an urgent request.
  holdReal(real);
  // COOLDOWN_MS === 0 means "off": wake exactly as the watcher did before this feature existed. It is
  // NOT "held until the cooldown expires", which never happens for a zero-length window.
  const urgent = held.some(urgentEnough);
  const off = COOLDOWN_MS === 0;
  const waitedOut = !off && Date.now() - lastWakeAt >= COOLDOWN_MS;
  if (!off && !urgent && !waitedOut) continue;
  const waking = held.slice();
  held.length = 0;
  heldIds.clear();
  if (deliverWake(waking, urgent) === "deferred") {
    holdReal(waking);
    continue;
  }
  break;
}
