// The Claude desktop app's Code tab, EMULATED: the app's own bundled claude.exe run the way the app runs it (a
// stream-json session whose stdin stays open, CLAUDE_CODE_ENTRYPOINT=claude-desktop), against a local hub and the
// helpers `opencadre connect` writes. It measures the two legs `claude -p` cannot: two open sessions are two agents, and
// an IDLE session wakes on new mail with nothing typed into it. Every leg asserts on the hub's records.
//
//   npx tsx scripts/dev/claude-desktop-emu.ts [--model haiku] [--idle-seconds 20]
//
// This is NOT the app: it is the app's binary in the app's process shape, without the app's host (its Electron shell,
// session management and UI). Evidence from it is labelled "emulated desktop entrypoint" and never stands alone for a
// GUI cell (LAUNCH-CLIENT-GATE.md §1; HARNESS-CLAUDE-CODE.md §10.4).
//
// The wake leg carries its own control: a third session whose settings lack ONLY the Stop hook's asyncRewake handler
// must NOT wake. (Setting CLAUDE_CODE_SESSION_ATTENDED=0 in this process's environment is not a control: measured
// 2026-09-30, a session started that way still woke.)
//
// Isolation is claude-live-smoke.ts's: a hub in this process on a database under OPENCADRE_SCRATCH, connect --home into
// a scratch home, --setting-sources project plus --settings/--strict-mcp-config pointing at the scratch files, and the
// parent's CLAUDE_CODE_* ids removed. Cost: three one-line turns and one mail reply.
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { baselineVerdict, controlVerdict, overallVerdict, preMailVerdict, wakeVerdict, type Probe, type Verdict } from "./claude-desktop-emu-verdicts.js";

const arg = (flag: string, fallback?: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback);
const MODEL = arg("--model", "haiku")!;
const IDLE_MS = Number(arg("--idle-seconds", "20")) * 1000;
const WAKE_WAIT_MS = 120_000;
const ROOT = process.env.OPENCADRE_SCRATCH ?? "B:\\ai-work\\temp\\claude-desktop-emu";
const RUN = path.join(ROOT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN, { recursive: true });
process.env.OPENCADRE_DB_PATH = path.join(RUN, "hub.db");
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const REPO = process.cwd();
const CLI = path.join(REPO, "cli", "bin", "opencadre.mjs");
/** The binary the desktop app runs: the newest version directory under %APPDATA%\Claude\claude-code, unless CLAUDE_EXE. */
function appClaude(): string {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const dir = path.join(process.env.APPDATA ?? "", "Claude", "claude-code");
  const versions = existsSync(dir) ? readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(path.join(dir, v, "claude.exe"))) : [];
  const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (!newest) throw new Error(`no bundled Claude Code under ${dir}; is the desktop app installed? (or set CLAUDE_EXE)`);
  return path.join(dir, newest, "claude.exe");
}
const CLAUDE = appClaude();

// A leg is PASS, FAIL, or INCONCLUSIVE (its prerequisites were not met, so it can certify nothing). Only all-PASS passes.
const results: Array<{ leg: string; status: Verdict["status"]; detail: string; falsifier: string }> = [];
const record = (leg: string, v: Verdict, falsifier: string) => {
  results.push({ leg, status: v.status, detail: v.detail, falsifier });
  console.log(`${v.status.padEnd(12)}  ${leg}: ${v.detail}`);
};
const log = (name: string, text: string) => writeFileSync(path.join(RUN, name), text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(500); }
  return pred();
};

const { startHub, operatorWorkspace, mintDevice, gitProject } = await import("../../tests/helpers/device-hub.js");
const hub = await startHub();
const { operatorKey } = await operatorWorkspace("Claude desktop emulation");
const REMOTE = "github.com/opencadre-smoke/claude-desktop-emu";
const project = gitProject("ClaudeDesktopEmu", `https://${REMOTE}.git`);
const home = path.join(RUN, "home");
mkdirSync(home, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const version = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
console.log(`subject: ${CLAUDE} (${version}), emulated desktop entrypoint, build ${sha}, hub ${hub.url}, run ${RUN}`);

const op = (method: string, route: string, body?: unknown) =>
  fetch(`${hub.url}${route}`, { method, headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
const sessions = async () => (await op("GET", "/v1/org/sessions")).body.sessions as Array<{ agentId: string; agentName: string; currentTask?: string | null }>;

// --- connect, exactly as a user runs it ------------------------------------------------------
const minted = await mintDevice(hub.url, operatorKey);
const childBase: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(OPENCADRE_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_AGENT_SDK)/i.test(k)) childBase[k] = v;
const connected = await new Promise<{ code: number | null; text: string }>((resolve) => {
  // Asynchronous: the hub lives in THIS process, so a synchronous spawn would stop it answering connect.
  const child = spawn(process.execPath, [CLI, "connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"],
    { cwd: project, env: { ...childBase, OPENCADRE_HOOK_HOME: home } });
  let text = "";
  child.stdout.on("data", (c) => (text += c));
  child.stderr.on("data", (c) => (text += c));
  child.stdin.end();
  child.on("close", (code) => resolve({ code, text }));
});
log("connect.txt", connected.text);
if (connected.code !== 0) throw new Error(`connect failed (${connected.code}); see ${RUN}\\connect.txt`);
const claudeJson = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
const mcpFile = path.join(RUN, "mcp.json");
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "opencadre-session": claudeJson.mcpServers["opencadre-session"] } }, null, 2));
const settingsFile = path.join(home, ".claude", "settings.json");
// The control's settings: identical except the Stop hook's asyncRewake handler (the idle-wake watcher) is gone.
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
let removed = 0;
for (const group of settings.hooks?.Stop ?? []) {
  const before = group.hooks.length;
  group.hooks = group.hooks.filter((h: { asyncRewake?: boolean }) => !h.asyncRewake);
  removed += before - group.hooks.length;
}
if (removed !== 1) throw new Error(`expected exactly one asyncRewake handler in ${settingsFile}, found ${removed}`);
const noWakeFile = path.join(RUN, "settings-nowake.json");
writeFileSync(noWakeFile, JSON.stringify(settings, null, 2));

// What the app sets for its Code tab sessions (read from a Code tab session's environment, 2026-09-30).
const env = { ...childBase, OPENCADRE_HOOK_HOME: home, CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ATTENDED: "1" };

type Session = Probe & { label: string; child: ChildProcessWithoutNullStreams; lastResultAt: number; typed: number; events: string[]; stderr: string; say: (text: string) => void };
function openSession(label: string, settingsPath: string): Session {
  const child = spawn(CLAUDE, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", MODEL,
    "--setting-sources", "project", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", mcpFile,
    "--allowedTools", "mcp__opencadre-session", "--session-id", randomUUID()], { cwd: project, env });
  const s: Session = { label, child, results: 0, firstResultOk: null, exitCode: null, exited: false, lastResultAt: 0, typed: 0, events: [], stderr: "", say: () => {} };
  child.on("exit", (code) => { s.exited = true; s.exitCode = code; });
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      s.events.push(line);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "result") {
          s.results++;
          s.lastResultAt = Date.now();
          if (s.results === 1) s.firstResultOk = ev.subtype === "success" && ev.is_error !== true;
        }
      } catch { /* not JSON */ }
    }
  });
  child.stderr.on("data", (c) => (s.stderr += c));
  s.say = (text) => { s.typed++; child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); };
  return s;
}
const run = randomUUID().slice(0, 6);
const statusPrompt = (task: string) => `Use the opencadre-session tools: call set_status with task "${task}". Then answer with just the word done.`;

const a = openSession("A", settingsFile);
const b = openSession("B", settingsFile);
const c = openSession("C-control", noWakeFile);
try {
  // --- Identity: two open sessions are two agents ------------------------------------------------
  a.say(statusPrompt(`desktop A ${run}`));
  b.say(statusPrompt(`desktop B ${run}`));
  c.say(statusPrompt(`desktop C ${run}`));
  const completed = await waitFor(() => a.results >= 1 && b.results >= 1 && c.results >= 1, 180_000);
  // Nothing below may run on an incomplete baseline: a status row can exist before its turn finished, and mail sent
  // then would be read at turn end and mislabelled idle wake (review 049a on #671).
  const baseline = baselineVerdict(completed, { A: a, B: b, "C-control": c });
  record("baseline", baseline, "inconclusive if any session's first turn did not finish successfully, a session exited, or the wait timed out");
  if (baseline.status !== "PASS") throw new Error(baseline.detail);
  const rows = await sessions();
  const mine = (task: string) => rows.filter((r) => r.currentTask === task);
  const [ra, rb, rc] = [mine(`desktop A ${run}`), mine(`desktop B ${run}`), mine(`desktop C ${run}`)];
  const identityOk = rows.length === 3 && ra.length === 1 && rb.length === 1 && rc.length === 1 && new Set([ra[0]?.agentId, rb[0]?.agentId, rc[0]?.agentId]).size === 3;
  record("identity", { status: identityOk ? "PASS" : "FAIL", detail: `${rows.length} session agent(s) for 3 open sessions: ${rows.map((r) => `${r.agentName}="${r.currentTask}"`).join(", ")}` },
    "fails if two open sessions share one agent, or a session adds a second (phantom) row");

  // --- Mail: an IDLE session wakes on new mail, and the watcher is what wakes it ------------------
  // A and C go idle; NOTHING is typed into either from here on. Both are mailed; only A has the watcher.
  if (!ra[0] || !rc[0]) throw new Error("identity found no agent for session A or C, so there is no one to mail; see the identity leg");
  // The idle interval is anchored to the COMPLETED baseline: it starts at the later of A's and C's first result.
  const idleFrom = Math.max(a.lastResultAt, c.lastResultAt);
  await sleep(Math.max(0, idleFrom + IDLE_MS - Date.now()));
  const idleSeconds = Number(((Date.now() - idleFrom) / 1000).toFixed(1));
  const ready = preMailVerdict({ A: a, "C-control": c });
  record("idle-before-mail", ready, "inconclusive if either session ran another turn after its first, or exited, before the mail");
  if (ready.status !== "PASS") throw new Error(ready.detail);
  const nonce = randomUUID().slice(0, 8);
  const typedBefore = { a: a.typed, c: c.typed };
  const resultsAtMail = { a: a.results, c: c.results };
  const mailed = await Promise.all([ra[0], rc[0]].map((r) => op("POST", "/v1/messages", { toAgent: r!.agentName, body: `Please reply on this thread with exactly: PONG-${nonce}` })));
  const sentAt = Date.now();
  await waitFor(() => a.results > resultsAtMail.a || a.exited, WAKE_WAIT_MS);
  const woke = a.results > resultsAtMail.a;
  const wakeSeconds = woke ? ((a.lastResultAt - sentAt) / 1000).toFixed(1) : null;
  // The control gets the same window, measured from the same send, whatever A did.
  await waitFor(() => false, Math.max(0, WAKE_WAIT_MS - (Date.now() - sentAt)));
  const thread = async (i: number) => (await op("GET", `/v1/messages/${mailed[i].body.threadId}/status`)).body.messages ?? [];
  const pongFrom = (msgs: any[], who: string) => msgs.some((m) => m.kind === "reply" && m.from === who && String(m.body).includes(`PONG-${nonce}`));
  const [ta, tc] = [await thread(0), await thread(1)];
  const aReplied = pongFrom(ta, ra[0]!.agentName);
  const cReplied = pongFrom(tc, rc[0]!.agentName);
  log("mail.json", JSON.stringify({ mailed: mailed.map((m) => m.body), threadA: ta, threadC: tc, wakeSeconds, idleSeconds, resultsAtMail,
    a: { results: a.results, exited: a.exited, exitCode: a.exitCode }, c: { results: c.results, exited: c.exited, exitCode: c.exitCode } }, null, 2));
  record("mail-idle-wake", wakeVerdict(a, { resultsAtMail: resultsAtMail.a, replied: aReplied, typedSinceMail: a.typed - typedBefore.a, seconds: wakeSeconds, windowSeconds: WAKE_WAIT_MS / 1000, idleSeconds, nonce }),
    "fails if the idle session does not start a turn on its own after the mail, or its reply is missing, on another thread, or from another agent; inconclusive if A exited first or anything was typed");
  record("mail-control", c.typed === typedBefore.c
    ? controlVerdict(c, { resultsAtMail: resultsAtMail.c, replied: cReplied, windowSeconds: WAKE_WAIT_MS / 1000 })
    : { status: "INCONCLUSIVE", detail: "something was typed into the control after the mail" },
    "fails if a session without the watcher wakes too; inconclusive if the control process exited during the window, since a dead control is silent too");
} catch (err) {
  // A prerequisite not met (recorded above as INCONCLUSIVE): stop measuring, keep the evidence.
  console.log(`stopped: ${(err as Error).message}`);
} finally {
  for (const s of [a, b, c]) {
    log(`session-${s.label}.jsonl`, s.events.join("\n"));
    log(`session-${s.label}.stderr.txt`, s.stderr);
    s.child.stdin.end();
  }
  await sleep(3000);
  for (const s of [a, b, c]) if (s.child.exitCode === null) s.child.kill();
}

log("results.json", JSON.stringify({ sha, claude: CLAUDE, version, instrument: "emulated desktop entrypoint", model: MODEL, hub: hub.url, results }, null, 2));
await hub.close();
// Every leg must have run AND passed: a run stopped at the baseline has fewer legs, and that is not a pass.
const LEGS = ["baseline", "identity", "idle-before-mail", "mail-idle-wake", "mail-control"];
const { verdict, passed, exitCode } = overallVerdict(LEGS, results);
console.log(`RESULT: ${verdict} (${passed}/${LEGS.length} legs passed)  instrument: emulated desktop entrypoint  evidence: ${RUN}`);
process.exit(exitCode);
