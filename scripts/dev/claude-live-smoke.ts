// Claude Code CLI, measured for real: the INSTALLED `claude` binary, the helpers `opencadre connect` writes, a local
// hub. Every leg drives real `claude -p` chats and asserts on the HUB's record of what they did, never on what the
// model says it did. LAUNCH-CLIENT-GATE.md §1: each leg names the input that would make it fail.
//
//   npx tsx scripts/dev/claude-live-smoke.ts [--model haiku] [--only identity,mail,clearance,lapsed,verified]
//
// Isolation, so the machine's own OpenCadre install is never read or written:
//   - the hub is booted in this process on a database under OPENCADRE_SCRATCH (default B:\ai-work\temp\claude-live);
//   - `opencadre connect --home <scratch home>` installs helpers and writes .claude.json / .claude/settings.json THERE;
//   - claude runs with `--setting-sources project` (a scratch project with no .claude dir) plus `--settings` and
//     `--strict-mcp-config --mcp-config` pointing at those two files, so ONLY the helpers under test run;
//   - OPENCADRE_HOOK_HOME points the helpers at the scratch home; the parent's CLAUDE_CODE_* ids are removed.
// Claude's own sign-in is untouched: the model call is the user's normal one. Cost: about eight short turns.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const arg = (flag: string, fallback?: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback);
const MODEL = arg("--model", "haiku")!;
const ONLY = new Set((arg("--only", "identity,mail,clearance,lapsed,verified") ?? "").split(","));
const ROOT = process.env.OPENCADRE_SCRATCH ?? "B:\\ai-work\\temp\\claude-live";
const RUN = path.join(ROOT, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN, { recursive: true });
process.env.OPENCADRE_DB_PATH = path.join(RUN, "hub.db");
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const REPO = process.cwd();
const CLI = path.join(REPO, "cli", "bin", "opencadre.mjs");
const CLAUDE = process.env.CLAUDE_EXE ?? execFileSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], { encoding: "utf8" })
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((p) => (p.endsWith(".cmd") ? path.join(path.dirname(p), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : p))
  .find((p) => existsSync(p) && !/\.(ps1|cmd)$/i.test(p) && (process.platform !== "win32" || /\.exe$/i.test(p)))!;

const results: Array<{ leg: string; pass: boolean; detail: string; falsifier: string }> = [];
const record = (leg: string, pass: boolean, detail: string, falsifier: string) => {
  results.push({ leg, pass, detail, falsifier });
  console.log(`${pass ? "PASS" : "FAIL"}  ${leg}: ${detail}`);
};
const log = (name: string, text: string) => writeFileSync(path.join(RUN, name), text);

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 300_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const { startHub, operatorWorkspace, mintDevice, gitProject } = await import("../../tests/helpers/device-hub.js");
const { asPerson, decideAsPerson } = await import("../../tests/helpers/person.js");
const { db } = await import("../../src/db.js");
const { assignPlan } = await import("../../src/billing.js");

const hub = await startHub();
const { orgId, operatorKey } = await operatorWorkspace("Claude live smoke");
const REMOTE = "github.com/opencadre-smoke/claude-live";
const project = gitProject("ClaudeLive", `https://${REMOTE}.git`);
const home = path.join(RUN, "home");
mkdirSync(home, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
console.log(`subject: ${CLAUDE} (${execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim()}), build ${sha}, hub ${hub.url}, run ${RUN}`);

const op = (method: string, route: string, body?: unknown) =>
  fetch(`${hub.url}${route}`, { method, headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
const sessions = async () => (await op("GET", "/v1/org/sessions")).body.sessions as Array<{ agentId: string; agentName: string; currentTask?: string | null; projectKey: string | null }>;

// --- connect, exactly as a user runs it ------------------------------------------------------
const minted = await mintDevice(hub.url, operatorKey);
const childBase: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(OPENCADRE_|CLAUDE_CODE_|CLAUDECODE)/i.test(k)) childBase[k] = v;
const connected = await run(process.execPath, [CLI, "connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"], { env: { ...childBase, OPENCADRE_HOOK_HOME: home }, cwd: project });
log("connect.txt", `${connected.out}\n--- stderr ---\n${connected.err}`);
if (connected.code !== 0) throw new Error(`connect failed (${connected.code}); see ${RUN}\\connect.txt`);
const claudeJson = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
const mcpFile = path.join(RUN, "mcp.json");
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "opencadre-session": claudeJson.mcpServers["opencadre-session"] } }, null, 2));
const settingsFile = path.join(home, ".claude", "settings.json");
// The proxy runs from the active generation (bin/.gen/<id>/); bin/opencadre-mcp.mjs is its entry stub.
const genDir = path.join(home, ".opencadre", "bin", ".gen", readFileSync(path.join(home, ".opencadre", "bin", ".gen", "current"), "utf8").trim());
const helperRev = execFileSync("git", ["hash-object", path.join(genDir, "opencadre-mcp.mjs")], { encoding: "utf8" }).trim();
console.log(`helpers installed by connect: opencadre-mcp.mjs blob ${helperRev}`);

const chatEnv = { ...childBase, OPENCADRE_HOOK_HOME: home };

// --probe-wake: does a headless `claude -p` wait for the Stop hook's asyncRewake watcher while it long-polls a LIVE hub?
// One trivial turn with every hook, one with all but the watcher, same everything else; each bounded at 120 s.
if (process.argv.includes("--probe-wake")) {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  const noWake = JSON.parse(JSON.stringify(settings));
  for (const group of noWake.hooks.Stop ?? []) group.hooks = group.hooks.filter((h: { asyncRewake?: boolean }) => !h.asyncRewake);
  const noWakeFile = path.join(RUN, "settings-nowake.json");
  writeFileSync(noWakeFile, JSON.stringify(noWake, null, 2));
  for (const [arm, file] of [["no-wake", noWakeFile], ["with-wake", settingsFile]] as const) {
    const started = Date.now();
    const r = await run(CLAUDE, ["-p", "Answer with just the word ok.", "--model", MODEL, "--output-format", "json", "--setting-sources", "project",
      "--settings", file, "--strict-mcp-config", "--mcp-config", mcpFile, "--session-id", randomUUID()], { env: chatEnv, cwd: project, timeoutMs: 120_000 });
    log(`probe-${arm}.txt`, `${r.out}
--- stderr ---
${r.err}`);
    console.log(`probe ${arm}: exit ${r.code} after ${Math.round((Date.now() - started) / 1000)} s, ${r.out.length} bytes of output`);
  }
  await hub.close();
  process.exit(0);
}
async function chat(prompt: string, { id, resume, label }: { id?: string; resume?: string; label: string }) {
  const args = ["-p", prompt, "--model", MODEL, "--output-format", "json", "--setting-sources", "project", "--settings", settingsFile,
    "--strict-mcp-config", "--mcp-config", mcpFile, "--allowedTools", "mcp__opencadre-session", "Bash",
    ...(resume ? ["--resume", resume] : ["--session-id", id!])];
  const r = await run(CLAUDE, args, { env: chatEnv, cwd: project, timeoutMs: 240_000 });
  log(`${label}.json`, r.out);
  log(`${label}.stderr.txt`, r.err);
  let text = "";
  try { text = JSON.parse(r.out).result ?? ""; } catch { text = r.out; }
  return { ...r, text };
}

const chatA = randomUUID();
const chatB = randomUUID();

// --- 2. Identity: TWO chats are TWO agents; the same chat resumed is the same agent ----------
if (ONLY.has("identity") || ONLY.has("mail") || ONLY.has("clearance") || ONLY.has("lapsed")) {
  await chat("Use the opencadre-session tools: call set_status with task \"identity A\". Then answer with just the word done.", { id: chatA, label: "identity-A" });
  await chat("Use the opencadre-session tools: call set_status with task \"identity B\". Then answer with just the word done.", { id: chatB, label: "identity-B" });
  await chat("Use the opencadre-session tools: call set_status with task \"identity A again\". Then answer with just the word done.", { resume: chatA, label: "identity-A-resumed" });
  const rows = await sessions();
  const a = rows.filter((s) => s.currentTask === "identity A again");
  const b = rows.filter((s) => s.currentTask === "identity B");
  const pass = rows.length === 2 && a.length === 1 && b.length === 1 && a[0].agentId !== b[0].agentId && rows.every((s) => s.projectKey === REMOTE);
  record("identity", pass, `${rows.length} session agent(s): ${rows.map((s) => `${s.agentName}="${s.currentTask}"`).join(", ")}`,
    "fails if the two chats share one agent (1 row), if the resumed chat became a third agent (3 rows), or if a row is filed under another project");
}

// --- 3. Mail: a message the chat was never told about is answered ON ITS THREAD at its next turn ---
let agentA: { agentId: string; agentName: string } | undefined;
if (ONLY.has("mail")) {
  agentA = (await sessions()).find((s) => s.currentTask === "identity A again");
  const nonce = randomUUID().slice(0, 8);
  const sent = await op("POST", "/v1/messages", { toAgent: agentA!.agentName, body: `Please reply on this thread with exactly: PONG-${nonce}` });
  const threadId = sent.body.threadId ?? sent.body.message?.threadId;
  // The prompt says NOTHING about mail: only the hooks can tell the chat it has any.
  await chat("Carry on with whatever is waiting for you, then answer with just the word done.", { resume: chatA, label: "mail-A" });
  // The hub's own record of the thread: who wrote what, in order. (A first version read the operator's inbox listing
  // with field names that listing does not have, and reported FAIL on a thread whose reply was sitting right there.)
  const thread = await op("GET", `/v1/messages/${threadId}/status`);
  const replies = (thread.body.messages ?? []).filter((m: any) => m.kind === "reply" && m.from === agentA!.agentName);
  const pass = replies.some((m: any) => String(m.body).includes(`PONG-${nonce}`));
  log("mail-thread.json", JSON.stringify({ sent: sent.body, thread: thread.body, replies }, null, 2));
  record("mail", pass, pass ? `reply on thread ${threadId} from ${agentA!.agentName} carries PONG-${nonce}` : `no reply carrying PONG-${nonce} on thread ${threadId}`,
    "fails if the hooks do not surface the message (the prompt never mentions it), or the reply lands on another thread or from another agent");
}

// --- 4. Clearance: a risky command is HELD before it runs, and a denial means it never ran ----------
if (ONLY.has("clearance")) {
  // Clearance policy is changed by a signed-in owner/admin PERSON (#653); an Operator key can only read it.
  await asPerson(hub.url, orgId, "PUT", "/v1/clearance-policy", { project: REMOTE, mode: "ask" });
  const sentinel = path.join(project, "sentinel-dir");
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(path.join(sentinel, "keep.txt"), "must survive");
  const turn = chat("Run exactly this Bash command and nothing else: rm -rf ./sentinel-dir  Then answer with just the word done.", { resume: chatB, label: "clearance-B" });
  let decided: any = null;
  for (let i = 0; i < 120 && !decided; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pending = (await op("GET", "/v1/approvals?status=pending")).body.approvals ?? [];
    const mine = pending.find((p: any) => /sentinel-dir/.test(JSON.stringify(p)));
    // A clearance is decided by a signed-in PERSON (person approvals, #653): the operator key's decide is refused with 403.
    if (mine) decided = { request: mine, decision: await (await decideAsPerson(hub.url, orgId, mine.id ?? mine.approvalId, { decision: "deny", note: "claude-live-smoke" })).json() };
  }
  await turn;
  const survived = existsSync(path.join(sentinel, "keep.txt"));
  log("clearance.json", JSON.stringify(decided, null, 2));
  const agentB = (await sessions()).find((s) => s.currentTask === "identity B");
  const byB = decided && JSON.stringify(decided.request).includes(agentB?.agentId ?? "\u0000");
  record("clearance", Boolean(decided) && survived && Boolean(byB),
    `${decided ? `approval held as ${byB ? agentB!.agentName : "ANOTHER AGENT"}, denied` : "no approval request appeared"}; sentinel ${survived ? "survived" : "WAS DELETED"}`,
    "fails if no request is held (policy ignored), if it is held under another agent, or if the sentinel is gone after the denial");
}

// --- 5. Lapsed bill: the tool keeps working as a plain tool; nothing blocks ----------------------
// A harmless command alone cannot fail this leg: the gate passes it whether or not the workspace lapsed. So the leg
// also runs a RISKY command under an Ask policy, which a paid workspace HOLDS (the clearance leg is that control), and
// asserts the lapsed one creates no approval request (a read-only workspace's hooks stop requesting approvals, site
// FAQ) while the console reads the workspace as read-only.
if (ONLY.has("lapsed")) {
  assignPlan(orgId, "trial");
  db.prepare(`UPDATE organizations SET trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
  // What the console reads for its "read-only" banner: /v1/me's billing, as the signed-in person.
  const me = await (await asPerson(hub.url, orgId, "GET", "/v1/me")).json() as { billing?: { readOnly?: boolean; reason?: string | null } };
  const readOnly = me.billing?.readOnly === true;
  const marker = path.join(project, "lapsed-marker.txt");
  rmSync(marker, { force: true });
  const r = await chat("Run exactly this Bash command: node -e \"require('fs').writeFileSync('lapsed-marker.txt','ran')\"  Then answer with just the word done.", { resume: chatA, label: "lapsed-A" });
  const ran = existsSync(marker);
  // The risky arm. The policy is set here, so the leg does not depend on the clearance leg having run first.
  await asPerson(hub.url, orgId, "PUT", "/v1/clearance-policy", { project: REMOTE, mode: "ask" });
  const lapsedDir = path.join(project, "lapsed-dir");
  mkdirSync(lapsedDir, { recursive: true });
  writeFileSync(path.join(lapsedDir, "gone.txt"), "a lapsed workspace does not hold this delete");
  const risky = await chat("Run exactly this Bash command and nothing else: rm -rf ./lapsed-dir  Then answer with just the word done.", { resume: chatA, label: "lapsed-risky-A" });
  const riskyRan = !existsSync(lapsedDir);
  // includeNoted: a notify-only record of the lapsed command counts as held too, as it did before the default hid them.
  const listed = (await op("GET", "/v1/approvals?includeNoted=true")).body.approvals ?? [];
  const held = listed.filter((a: any) => /lapsed-dir/.test(JSON.stringify(a)));
  // The listing's own known positive: when the clearance leg ran, its request must be in the same listing, or a zero
  // above could come from a listing that returns nothing.
  const listingSeesKnown = !ONLY.has("clearance") || listed.some((a: any) => /sentinel-dir/.test(JSON.stringify(a)));
  const blocked = /blocked|denied|OpenCadre approval gate/i.test(r.text + r.out + risky.text + risky.out);
  log("lapsed.json", JSON.stringify({ billing: me.billing, listed: listed.length, held, listingSeesKnown }, null, 2));
  record("lapsed", r.code === 0 && ran && risky.code === 0 && riskyRan && held.length === 0 && listingSeesKnown && readOnly && !blocked,
    `console billing.readOnly=${me.billing?.readOnly} (${me.billing?.reason ?? "no reason"}); harmless command ${ran ? "ran" : "DID NOT RUN"}; `
      + `risky rm -rf under Ask ${riskyRan ? "ran" : "DID NOT RUN"} with ${held.length} approval request(s)`
      + `${ONLY.has("clearance") ? `; listing ${listingSeesKnown ? "shows" : "DOES NOT SHOW"} the paid clearance request` : ""}; ${blocked ? "a block/deny was reported" : "no block reported"}`,
    "fails if the console does not read the workspace as read-only, if the lapsed gate still requests an approval or blocks the risky command, if either command never runs, or if the approvals listing cannot see the paid leg's request");
  assignPlan(orgId, "internal");
}

// --- 6. Verified: doctor reproduces it, and a broken input turns it red ----------------------
if (ONLY.has("verified")) {
  const doctor = await run(process.execPath, [CLI, "doctor", "--client", "claude-code", "--home", home], { env: chatEnv, cwd: project });
  log("doctor.txt", doctor.out + doctor.err);
  const creds = path.join(home, ".opencadre", "credentials.json");
  const saved = readFileSync(creds, "utf8");
  writeFileSync(creds, saved.replace(/dev_[A-Za-z0-9]+/, `dev_${"0".repeat(48)}`));
  const broken = await run(process.execPath, [CLI, "doctor", "--client", "claude-code", "--home", home], { env: chatEnv, cwd: project });
  writeFileSync(creds, saved);
  log("doctor-broken.txt", broken.out + broken.err);
  record("verified", doctor.code === 0 && broken.code !== 0, `doctor exit ${doctor.code}; with a revoked-looking credential exit ${broken.code}`,
    "fails if doctor is red on the working install, or stays green when the credential is replaced by one the hub does not know");
}

log("results.json", JSON.stringify({ sha, helperRev, claude: CLAUDE, model: MODEL, hub: hub.url, results }, null, 2));
await hub.close();
const failed = results.filter((r) => !r.pass);
console.log(`RESULT: ${failed.length ? "FAIL" : "PASS"} (${results.length - failed.length}/${results.length})  evidence: ${RUN}`);
process.exit(failed.length ? 1 : 0);
