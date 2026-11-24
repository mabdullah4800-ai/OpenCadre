// A measuring rig for the Cursor row (LAUNCH-CLIENT-GATE.md §1): a local hub that stays up, a scratch HOME that
// `opencadre connect --client cursor` configures exactly as it would a customer's, and a test project. `launch` starts
// Cursor with USERPROFILE/HOME pointed at that scratch home, so the editor reads the rig's ~/.cursor (hooks, global
// server) and the project's .cursor/mcp.json, and the helpers read the rig's credential: the machine's own ~/.cursor and
// the production hub are not loaded. Cursor's sign-in lives in %APPDATA%\Cursor, which is left alone.
//
//   npx tsx scripts/dev/cursor-app-rig.ts serve            # boots the hub, connects the scratch home, stays up
//   npx tsx scripts/dev/cursor-app-rig.ts launch           # starts Cursor (must not already be running) on the project
//   npx tsx scripts/dev/cursor-app-rig.ts <command> ...    # talks to a running rig (see COMMANDS)
//
// connect is run with the scratch home in USERPROFILE/HOME, not `--home`: a home override skips the project server
// (cli/bin/opencadre.mjs cursorProjectRoot), and the project server is what Cursor's chats use.
//
// Keys, as in claude-app-rig.ts. The rig's operator key lives ONLY in the serve process's memory (fleet rule: keys only
// in client config; the scratch drive is portable). Commands reach it through a control port bound to 127.0.0.1 that also
// requires a per-run capability token (random, not an OpenCadre key, useless once the rig stops). The computer
// credential connect writes is client config (home/.opencadre/credentials.json), as on a real install. Every serve
// starts a fresh workspace, and a command refuses to run against a rig served from a different build than this checkout.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const ROOT = process.env.OPENCADRE_SCRATCH ?? "B:\\ai-work\\temp\\cursor-app";
const STATE = path.join(ROOT, "rig-state.json");
const PORT = Number(process.env.RIG_PORT ?? 47112);
const CONTROL_PORT = PORT + 1;
const REPO = process.cwd();
const CLI = path.join(REPO, "cli", "bin", "opencadre.mjs");
const REMOTE = "github.com/opencadre-smoke/cursor-app";
const cmd = process.argv[2];
const headSha = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
// The scratch home stands in for the customer's user profile, for connect, Cursor and doctor alike.
const asHome = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OPENCADRE_|CLAUDE_CODE_|CLAUDECODE)/i.test(k)) env[k] = v;
  return { ...env, USERPROFILE: home, HOME: home };
};

type State = { hub: string; control: string; controlToken: string; orgId: string; project: string; home: string; sha: string };
const readState = (): State => JSON.parse(readFileSync(STATE, "utf8"));
const COMMANDS = "serve | launch | sessions | send <agent> <text> | thread <threadId> | policy <off|notify|ask|strict> | pending | decide <id> <approve|deny> | lapse | restore | sentinel | doctor";

if (cmd === "serve") {
  mkdirSync(ROOT, { recursive: true });
  process.env.OPENCADRE_DB_PATH = path.join(ROOT, "hub.db");
  process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
  const http = await import("node:http");
  const { app } = await import("../../src/rest.js");
  const { handleMcpRequest } = await import("../../src/mcp.js");
  const { db } = await import("../../src/db.js");
  const { operatorWorkspace, mintDevice } = await import("../../tests/helpers/device-hub.js");
  const server = http.createServer((req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req, res);
      });
      return;
    }
    app(req, res);
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  const hub = `http://127.0.0.1:${PORT}`;
  const sha = headSha();

  // Always a fresh workspace: the key that would resume an old one was never written down.
  rmSync(STATE, { force: true });
  const { orgId, operatorKey } = await operatorWorkspace("Cursor rig");
  const home = path.join(ROOT, "home");
  const project = path.join(ROOT, "CursorProj");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (!existsSync(path.join(project, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["remote", "add", "origin", `https://${REMOTE}.git`], { cwd: project });
  }
  const minted = await mintDevice(hub, operatorKey, "cursor");
  // Asynchronous: the hub lives in THIS process, so a synchronous spawn would stop it answering connect.
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, "connect", "--hub", hub, "--code", minted.code, "--client", "cursor"], { cwd: project, env: asHome(home) });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, text }));
  });
  writeFileSync(path.join(ROOT, "connect.txt"), out.text);
  if (out.code !== 0) throw new Error(`connect failed (${out.code}); see ${path.join(ROOT, "connect.txt")}`);
  mkdirSync(path.join(project, "sentinel-dir"), { recursive: true });
  writeFileSync(path.join(project, "sentinel-dir", "keep.txt"), "must survive");

  // --- the control port: every command that needs the operator key runs HERE, in the process that holds it -------
  const op = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${hub}${route}`, { method, headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.json().catch(() => null) as Promise<any>;
  };
  const run = async (name: string, args: string[]): Promise<unknown> => {
    switch (name) {
      case "sessions": return ((await op("GET", "/v1/org/sessions")).sessions ?? []).map((x: any) => ({ agentName: x.agentName, agentId: x.agentId, task: x.currentTask ?? null, project: x.projectKey, liveness: x.liveness ?? null }));
      case "send": return op("POST", "/v1/messages", { toAgent: args[0], body: args[1] });
      case "thread": return op("GET", `/v1/messages/${args[0]}/status`);
      // Clearance policy is changed by a signed-in owner/admin PERSON (#653); an Operator key can only read it.
      case "policy": {
        const { asPerson } = await import("../../tests/helpers/person.js");
        return (await asPerson(hub, orgId, "PUT", "/v1/clearance-policy", { project: REMOTE, mode: args[0] })).json().catch(() => null);
      }
      case "pending": return (await op("GET", "/v1/approvals?status=pending")).approvals;
      // A clearance is decided by a signed-in PERSON (person approvals, #653): the operator key's decide is refused with 403.
      case "decide": {
        const { decideAsPerson } = await import("../../tests/helpers/person.js");
        return (await decideAsPerson(hub, orgId, args[0], { decision: args[1] as "approve" | "deny", note: "cursor-app-rig" })).json().catch(() => null);
      }
      case "lapse":
        // The billing column the enforcement path reads (as tests/device-corridor.test.ts does).
        db.prepare(`UPDATE organizations SET plan = 'trial', trial_ends_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), orgId);
        return "workspace lapsed";
      case "restore":
        db.prepare(`UPDATE organizations SET plan = 'internal', trial_ends_at = NULL, lapsed_at = NULL, subscription_status = 'active' WHERE id = ?`).run(orgId);
        return "workspace restored";
      default: throw new Error(`unknown command ${name}; commands: ${COMMANDS}`);
    }
  };
  const controlToken = randomBytes(24).toString("hex");
  const tokenOk = (given: unknown) => {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(controlToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const control = http.createServer((req, res) => {
    if (!tokenOk(req.headers["x-rig-token"])) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "missing or wrong rig token" }));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const { name, args } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: await run(name, args ?? []) }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    });
  });
  await new Promise<void>((r) => control.listen(CONTROL_PORT, "127.0.0.1", () => r()));
  const state: State = { hub, control: `http://127.0.0.1:${CONTROL_PORT}`, controlToken, orgId, project, home, sha };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`rig ready: hub ${hub}, control ${state.control}, build ${sha}, project ${project}`);
  console.log("serving; Ctrl-C to stop");
  await new Promise(() => {});
} else {
  // --- commands against a running rig -------------------------------------------------------
  const s = readState();
  // A rig served from another build would measure that build under this checkout's name.
  if (cmd && s.sha !== headSha()) {
    console.error(`rig was served from ${s.sha}, this checkout is ${headSha()}: stop it and serve again from this build`);
    process.exit(1);
  }
  const print = (x: unknown) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
  if (cmd === "sentinel") {
    print(existsSync(path.join(s.project, "sentinel-dir", "keep.txt")) ? "sentinel present" : "SENTINEL GONE");
  } else if (cmd === "doctor") {
    const child = spawn(process.execPath, [CLI, "doctor", "--client", "cursor"], { cwd: s.project, stdio: "inherit", env: asHome(s.home) });
    await new Promise((r) => child.on("close", (code) => { console.log(`doctor exit ${code}`); r(null); }));
  } else if (cmd === "launch") {
    const exe = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe");
    const child = spawn(exe, [s.project], { detached: true, stdio: "ignore", env: asHome(s.home) });
    child.unref();
    print(`Cursor launched on ${s.project} with home ${s.home} (it must not have been running already)`);
  } else if (cmd) {
    const r = await fetch(s.control, { method: "POST", headers: { "x-rig-token": s.controlToken }, body: JSON.stringify({ name: cmd, args: process.argv.slice(3) }) });
    const body = await r.json() as { ok: boolean; result?: unknown; error?: string };
    if (!body.ok) { console.error(body.error); process.exit(1); }
    print(body.result);
  } else {
    console.log(`commands: ${COMMANDS}`);
  }
}
