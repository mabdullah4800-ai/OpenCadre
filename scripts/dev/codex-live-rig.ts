// Real Codex CLI launch rig. Keep the local hub's operator key in this process, never on disk.
// The signed-in Codex auth file is linked into a B: test CODEX_HOME; its contents are not copied.
// `opencadre connect --home` writes the test MCP config, hooks and device credential there.
// Run: npx tsx scripts/dev/codex-live-rig.ts
// Then run Codex 0.157.1 with CODEX_HOME and OPENCADRE_HOOK_HOME printed below, from PROJECT.
// Type help on this rig's stdin for the hub-backed evidence commands.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { installedText } from "../../cli/lib/helpers.mjs";

const root = process.env.OPENCADRE_SCRATCH ?? "B:\\ai-work\\temp\\codex-trio-rig";
const home = process.env.OPENCADRE_CANARY_HOME ?? path.join(root, "home");
const codexHome = path.join(home, ".codex");
const project = path.join(root, "project");
const remote = "github.com/opencadre-smoke/codex-trio";
const cli = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const realAuth = path.join(homedir(), ".codex", "auth.json");
const authLink = path.join(codexHome, "auth.json");
if (existsSync(root)) throw new Error(`Use a fresh OPENCADRE_SCRATCH path: ${root}`);
if (!existsSync(realAuth)) throw new Error("The real Codex profile has no auth.json to link");
mkdirSync(root, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["remote", "add", "origin", `https://${remote}.git`], { cwd: project });
process.env.OPENCADRE_DB_PATH = path.join(root, "hub.db");
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const { startHub, operatorWorkspace, mintDevice } = await import("../../tests/helpers/device-hub.js");
const { asPerson, decideAsPerson } = await import("../../tests/helpers/person.js");
const { db } = await import("../../src/db.js");
const { assignPlan } = await import("../../src/billing.js");
const hub = await startHub();
const { orgId, operatorKey } = await operatorWorkspace("Codex trio rig");
const minted = await mintDevice(hub.url, operatorKey, "codex");
const cleanEnv: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(CODEX_|OPENCADRE_|OPENAI_)/i.test(k)) cleanEnv[k] = v;
const connected = await new Promise<{ code: number | null; err: string }>((resolve) => {
  const child = spawn(process.execPath, [cli, "connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex", ...(process.env.OPENCADRE_CANARY_HOME ? ["--replace"] : [])],
    { cwd: project, env: { ...cleanEnv, OPENCADRE_HOOK_HOME: home } });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  child.stdout.resume();
  child.stdin.end();
  child.on("close", (code) => resolve({ code, err }));
});
if (connected.code !== 0) throw new Error(`OpenCadre connect failed (${connected.code}); ${connected.err.replace(/(?:agt|dev|org)_[A-Za-z0-9]+/g, "[redacted]")}`);
mkdirSync(codexHome, { recursive: true });
// Codex does not forward the parent OPENCADRE_HOOK_HOME to stdio MCP children. Bind this
// test-only server explicitly so it reads the local rig credential rather than the real home.
const configFile = path.join(codexHome, "config.toml");
const configText = readFileSync(configFile, "utf8");
// Reconnect can leave other TOML tables after the MCP table. Insert the test environment INSIDE
// our server table, never at EOF where it would become an unrelated hook/project field.
const cleanedConfig = configText.replace(/^env = \{ OPENCADRE_HOOK_HOME = [^\r\n]*\}\r?\n?/gm, "");
const serverHeader = "[mcp_servers.opencadre-session]";
const serverAt = cleanedConfig.indexOf(serverHeader);
if (serverAt < 0) throw new Error("Connect did not configure the Codex session server");
const nextTable = cleanedConfig.indexOf("\n[", serverAt + serverHeader.length);
const insertAt = nextTable < 0 ? cleanedConfig.length : nextTable;
const serverEnv = `env = { OPENCADRE_HOOK_HOME = ${JSON.stringify(home)} }\n`;
writeFileSync(configFile, cleanedConfig.slice(0, insertAt).trimEnd() + "\n" + serverEnv + cleanedConfig.slice(insertAt));
if (process.argv[2] === "auto") {
  // The rig created this empty project; pre-trust only this exact disposable path for headless runs.
  const trustKey = project.toLowerCase().replaceAll("'", "''");
  const current = readFileSync(configFile, "utf8");
  if (!current.includes("[projects.'" + trustKey + "']")) {
    writeFileSync(configFile, current.trimEnd() + "\n\n[projects.'" + trustKey + "']\ntrust_level = \"trusted\"\n");
  }
}
if (existsSync(authLink)) {
  if (readlinkSync(authLink) !== realAuth) throw new Error("Test auth link points somewhere unexpected");
  unlinkSync(authLink);
}
symlinkSync(realAuth, authLink, "file");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sentinel = path.join(project, "sentinel-dir");
mkdirSync(sentinel, { recursive: true });
writeFileSync(path.join(sentinel, "keep.txt"), "must survive a denied command");
console.log(JSON.stringify({ ready: true, sha, hub: hub.url, project, home, CODEX_HOME: codexHome, OPENCADRE_HOOK_HOME: home }));
console.log("commands: help | sessions | send <agent> <text> | thread <id> | policy <off|ask> | pending | deny <id> | lapse | restore | sentinel | doctor | quit");

const op = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`${hub.url}${route}`, { method, headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
// A clearance is decided by a signed-in PERSON (person approvals, #653): the operator key's decide is refused with 403.
const personDecide = async (id: string, body: { decision: "approve" | "deny"; note?: string }) => {
  const r = await decideAsPerson(hub.url, orgId, id, body);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
// Clearance policy is changed by a signed-in owner/admin PERSON (#653); an Operator key can only read it.
const setPolicy = async (project: string, mode: string) => {
  const r = await asPerson(hub.url, orgId, "PUT", "/v1/clearance-policy", { project, mode });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const print = (x: unknown) => console.log(JSON.stringify(x));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  // Remove only the symlink we created. Never touch its target in the real signed-in profile.
  if (existsSync(authLink) && readlinkSync(authLink) === realAuth) unlinkSync(authLink);
  await hub.close();
  rl.close();
}
async function command(line: string) {
  const [name, ...args] = line.trim().split(" ");
  switch (name) {
    case "help": console.log("sessions | send <agent> <text> | thread <id> | policy <off|ask> | pending | deny <id> | lapse | restore | sentinel | doctor | quit"); break;
    case "sessions": {
      const r = await op("GET", "/v1/org/sessions");
      print((r.body?.sessions ?? []).map((x: any) => ({ agent: x.agentName, id: x.agentId, task: x.currentTask, project: x.projectKey })));
      break;
    }
    case "send": {
      const [toAgent, ...words] = args;
      const r = await op("POST", "/v1/messages", { toAgent, body: words.join(" ") });
      print({ status: r.status, threadId: r.body?.threadId ?? r.body?.message?.threadId });
      break;
    }
    case "thread": {
      const r = await op("GET", `/v1/messages/${args[0]}/status`);
      print({ status: r.status, messages: (r.body?.messages ?? []).map((m: any) => ({ from: m.from, kind: m.kind, body: m.body })) });
      break;
    }
    case "policy": {
      if (!["off", "ask"].includes(args[0])) throw new Error("policy accepts off or ask");
      const r = await setPolicy(remote, args[0]);
      print({ status: r.status, mode: args[0], ok: r.body?.ok });
      break;
    }
    case "pending": {
      const r = await op("GET", "/v1/approvals?status=pending");
      print((r.body?.approvals ?? []).map((x: any) => ({ id: x.id ?? x.approvalId, agentId: x.agentId, category: x.category, action: x.action })));
      break;
    }
    case "deny": {
      const r = await personDecide(args[0], { decision: "deny", note: "codex-live-rig" });
      print({ status: r.status, ok: r.body?.ok });
      break;
    }
    case "lapse": {
      assignPlan(orgId, "trial");
      db.prepare("UPDATE organizations SET trial_ends_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), orgId);
      print({ lapsed: true });
      break;
    }
    case "restore": {
      assignPlan(orgId, "internal");
      db.prepare("UPDATE organizations SET trial_ends_at = NULL, lapsed_at = NULL, subscription_status = 'active' WHERE id = ?").run(orgId);
      print({ restored: true });
      break;
    }
    case "sentinel": print({ survived: existsSync(path.join(sentinel, "keep.txt")) }); break;
    case "doctor": {
      const child = spawn(process.execPath, [cli, "doctor", "--client", "codex", "--home", home], { cwd: project, env: cleanEnv });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.stdin.end();
      await new Promise((r) => child.on("close", (code) => { print({ code, verdict: /verdict=([^\s]+)/.exec(out)?.[1], hooks: /hooks=([^\s]+)/.exec(out)?.[1] }); r(null); }));
      break;
    }
    case "quit": await stop(); break;
    default: console.log("unknown command; type help");
  }
}
rl.on("line", (line) => { queue = queue.then(() => command(line)).catch((e) => console.log(`error: ${String(e?.message ?? e)}`)); });
process.on("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void stop().then(() => process.exit(0)); });

// `auto` is a bounded, unattended compatibility canary. It runs only helpers just installed from
// this checkout in a fresh scratch home and requires persisted hook trust in a reusable B: test
// profile. True idle wake and the desktop app remain separate manual launch cells.
if (process.argv[2] === "auto") {
  const cells: string[] = [];
  const redact = (s: string) => s.replace(/(?:agt|dev|org)_[A-Za-z0-9]+/g, "[redacted]");
  try {
  const codexJs = process.env.OPENCADRE_CODEX_JS;
  if (!codexJs || !existsSync(codexJs)) throw new Error("Set OPENCADRE_CODEX_JS to an installed Codex codex.js");
  const helpersToCheck = [
    "opencadre-mcp.mjs", "opencadre-wake.mjs", "opencadre-awareness.mjs",
    "opencadre-approval-gate.mjs", "opencadre-session-stamp.mjs",
  ];
  for (const name of helpersToCheck) {
    const expected = Buffer.from(installedText(name));
    // The helpers run from the active generation (bin/.gen/<id>/, cli/lib/generations.mjs); bin/<name> is its entry stub.
    const bin = path.join(home, ".opencadre", "bin");
    const actual = readFileSync(path.join(bin, ".gen", readFileSync(path.join(bin, ".gen", "current"), "utf8").trim(), name));
    if (!expected.equals(actual)) throw new Error("Installed helper differs from source: " + name);
  }
  const codexBinDir = path.resolve(path.dirname(codexJs), "../../..", ".bin");
  const codexEnv = {
    ...cleanEnv,
    CODEX_HOME: codexHome,
    OPENCADRE_HOOK_HOME: home,
    OPENCADRE_WAKE_STATE_DIR: root,
    OPENCADRE_AWARENESS_STATE_DIR: root,
    PATH: codexBinDir + path.delimiter + (cleanEnv.PATH ?? cleanEnv.Path ?? ""),
  };
  const ensure = (ok: unknown, label: string): asserts ok => { if (!ok) throw new Error(label); };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runCodex = (args: string[], timeoutMs = 240_000) => new Promise<{ code: number | null; out: string; id: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [codexJs, ...args], { cwd: project, env: codexEnv, windowsHide: true });
    child.stdin.end();
    let out = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-250_000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Codex timed out: " + redact(out.slice(-2000)))); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, id: /session id:\s*([0-9a-f-]{36})/i.exec(out)?.[1] ?? null });
    });
  });
  const execArgs = (prompt: string) => ["exec", "--approve-for-me", "-m", "gpt-6-sol", prompt];
  const resumeArgs = (id: string, prompt: string) => ["exec", "--approve-for-me", "-m", "gpt-6-sol", "resume", id, prompt];
  const checkRun = (r: { code: number | null; out: string }, cell: string) => ensure(r.code === 0, cell + ": Codex exit " + r.code + ": " + redact(r.out.slice(-2000)));
  const doctorRun = () => new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "doctor", "--client", "codex", "--home", home], { cwd: project, env: codexEnv });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
    let d = await doctorRun();
    ensure(d.code === 0 && d.out.includes("verdict=healthy") && d.out.includes("hooks=present") && d.out.includes("has recorded hook trust"), "connect/doctor or hook trust failed: " + redact(d.out.slice(-1500)));
    cells.push("connect");
    const a = await runCodex(execArgs("Canary chat A. Call native OpenCadre get_active_agents, then set_status task CANARY-A phase testing. Report your OpenCadre name. No shell commands."));
    checkRun(a, "identity A"); ensure(a.id, "identity A missing session id");
    const b = await runCodex(execArgs("Canary chat B. Call native OpenCadre get_active_agents, then set_status task CANARY-B phase testing. Report your OpenCadre name. No shell commands."));
    checkRun(b, "identity B"); ensure(b.id, "identity B missing session id");
    const roster = await op("GET", "/v1/org/sessions");
    const sessions = roster.body?.sessions ?? [];
    const sa = sessions.find((x: any) => x.currentTask === "CANARY-A");
    const sb = sessions.find((x: any) => x.currentTask === "CANARY-B");
    ensure(sessions.length === 2 && sa?.agentId && sb?.agentId && sa.agentId !== sb.agentId, "identity did not produce exactly two distinct agents");
    cells.push("identity");
    const marker = "CANARY-MAIL-" + Date.now();
    const sent = await op("POST", "/v1/messages", { toAgent: sa.agentName, body: "Reply on this thread with " + marker });
    const threadId = sent.body?.threadId ?? sent.body?.message?.threadId;
    ensure(sent.status === 201 && threadId, "mail send failed");
    const mailTurn = await runCodex(resumeArgs(a.id, "What is 6 times 7? Check your OpenCadre inbox if a hook reports mail; answer it on its thread."));
    checkRun(mailTurn, "mail next turn");
    const thread = await op("GET", "/v1/messages/" + threadId + "/status");
    ensure(thread.body?.messages?.some((x: any) => x.from === sa.agentName && x.body?.includes(marker)), "mail reply missing on original thread");
    cells.push("mail-next-turn");
    const policy = await setPolicy(remote, "ask");
    ensure(policy.status === 200, "clearance policy setup failed");
    try {
      const clearanceTurn = runCodex(resumeArgs(b.id, "Authorized disposable clearance canary. Execute PowerShell Remove-Item -Recurse -Force .\\sentinel-dir in the shell tool now. Do not call request_approval manually: the installed PreToolUse clearance hook will ask the operator before the shell command runs. Stop if denied."));
      let approval: any = null;
      const until = Date.now() + 180_000;
      while (Date.now() < until && !approval) {
        const pending = await op("GET", "/v1/approvals?status=pending");
        approval = (pending.body?.approvals ?? []).find((x: any) => x.requested_by_agent_name === sb.agentName && String(x.action).includes("Remove-Item -Recurse -Force .\\sentinel-dir"));
        if (!approval) await pause(1500);
      }
      ensure(approval, "expected B clearance request was not held");
      const denied = await personDecide(approval.id ?? approval.approvalId, { decision: "deny", note: "codex-canary" });
      ensure(denied.status === 200, "clearance denial failed");
      ensure(approval.category === "ps-recursive-delete" && approval.action === "Remove-Item -Recurse -Force .\\sentinel-dir", "model requested manual approval instead of exercising PreToolUse clearance gate");
      const result = await clearanceTurn;
      checkRun(result, "clearance turn");
      ensure(existsSync(path.join(sentinel, "keep.txt")), "clearance sentinel was deleted");
      cells.push("clearance");
    } finally {
      await setPolicy(remote, "off");
    }
    assignPlan(orgId, "trial");
    db.prepare("UPDATE organizations SET trial_ends_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), orgId);
    try {
      const lapseTurn = await runCodex(resumeArgs(a.id, "Lapsed-bill canary. Call native OpenCadre get_active_agents, then use PowerShell Set-Content to write ran to ./canary-lapsed.txt and read it back. Report both results."));
      checkRun(lapseTurn, "lapsed turn");
      ensure(readFileSync(path.join(project, "canary-lapsed.txt"), "utf8").trim() === "ran", "lapsed command did not run");
      cells.push("lapsed-bill");
    } finally {
      assignPlan(orgId, "internal");
      db.prepare("UPDATE organizations SET trial_ends_at = NULL, lapsed_at = NULL, subscription_status = 'active' WHERE id = ?").run(orgId);
    }
    d = await doctorRun();
    ensure(d.code === 0 && d.out.includes("verdict=healthy"), "healthy doctor control failed");
    const credentialFile = path.join(home, ".opencadre", "credentials.json");
    const original = readFileSync(credentialFile, "utf8");
    try {
      const parsed = JSON.parse(original);
      const value = String(parsed.computer.credential);
      ensure(value.length > 8, "test credential missing");
      parsed.computer.credential = value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
      writeFileSync(credentialFile, JSON.stringify(parsed));
      const bad = await doctorRun();
      ensure(bad.code === 1 && bad.out.includes("HTTP 401") && bad.out.includes("verdict=check_hub"), "rejected credential did not make doctor red");
    } finally {
      writeFileSync(credentialFile, original);
    }
    d = await doctorRun();
    ensure(d.code === 0 && d.out.includes("verdict=healthy"), "restored doctor did not recover");
    cells.push("verified");
    print({ canary: "passed", sha, cells, idleWake: "manual TUI leg required", app: "separate real desktop row required" });
  } catch (err: any) {
    print({ canary: "failed", sha, cells, error: redact(String(err?.message ?? err)) });
    process.exitCode = 1;
  } finally {
    await stop();
  }
}
