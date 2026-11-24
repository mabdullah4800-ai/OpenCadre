// Product scripts that run unattended, from a hook or a background watcher, start their child processes with
// `windowsHide: true`. Such a script often runs under a parent with no console (an agent app, a detached watcher), and
// there a console child without windowsHide opens a visible window on Windows. Each script runs for real under
// tests/helpers/record-spawn-options.mjs, which records the options of every child_process call it makes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const ROOT = process.cwd();
const RECORDER = pathToFileURL(path.join(ROOT, "tests", "helpers", "record-spawn-options.mjs")).href;
type Call = { fn: string; file: string; args: string[]; windowsHide: boolean | null };

let hub: http.Server;
let hubUrl: string;
beforeAll(async () => {
  // Answers every request with an `ask` policy, so the gate reads a project and evaluates its rules.
  hub = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ mode: "ask" })); });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const addr = hub.address();
  hubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => { hub.closeAllConnections(); hub.close(() => resolve()); }));

const scratch = () => mkdtempSync(path.join(tmpdir(), "spawn-hide-"));

/** Runs `node --import <recorder> ...nodeArgs` and returns every child_process call the script made. */
function recorded(nodeArgs: string[], { env = {}, input = "", cwd = ROOT }: { env?: Record<string, string>; input?: string; cwd?: string } = {}): Promise<Call[]> {
  const record = path.join(scratch(), "calls.jsonl");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", RECORDER, ...nodeArgs], { cwd, env: { ...process.env, ...env, SPAWN_RECORD_FILE: record } });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.resume();
    child.on("error", reject);
    child.on("exit", () => {
      if (!existsSync(record)) return resolve([]);
      try {
        resolve(readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call));
      } catch (e) { reject(new Error(`${String(e)}\n${err}`)); }
    });
    child.stdin.end(input);
  });
}

describe("unattended product spawns hide their console", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("the recorder reports a call made without windowsHide (the instrument can say no)", async () => {
    const calls = await recorded(["-e", "require('node:child_process').spawnSync(process.execPath, ['-e', ''])"]);
    expect(calls).toEqual([{ fn: "spawnSync", file: process.execPath, args: ["-e", ""], windowsHide: null }]);
  });

  it("the approval gate's git reads (project key, current branch)", async () => {
    const repo = scratch();
    execFileSync("git", ["init", "-q", "-b", "feature-x"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: repo });
    const home = scratch();
    // A branch-aware rule on an unprotected branch: the gate reads the origin for the project key, then the branch.
    const calls = await recorded([path.join(ROOT, "examples", "hooks", "opencadre-approval-gate.mjs")], {
      cwd: repo,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin feature-y" }, cwd: repo }),
      env: { ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, OPENCADRE_GATE_MODE: "", OPENCADRE_GATE_CONFIG: "", OPENCADRE_URL: hubUrl, OPENCADRE_KEY: "test-placeholder" },
    });
    const git = calls.filter((c) => c.file === "git").map((c) => c.args.join(" "));
    expect(git).toEqual(expect.arrayContaining(["remote get-url origin", "rev-parse --abbrev-ref HEAD"]));
    expect(calls.filter((c) => c.windowsHide !== true)).toEqual([]);
  });

  it("the Reasonix hook wrapper's run of the awareness script", async () => {
    const folder = scratch();
    writeFileSync(path.join(folder, "reasonix.toml"), [
      "[[plugins]]",
      'name    = "opencadre"',
      'type    = "http"',
      `url     = "${hubUrl}/mcp"`,
      'headers = { Authorization = "Bearer test-placeholder" }',
      "",
    ].join("\n"));
    const home = scratch();
    const calls = await recorded([path.join(ROOT, "scripts", "reasonix-opencadre-hook.mjs")], {
      cwd: folder,
      input: JSON.stringify({ event: "SessionStart", sessionId: "spawn-hide-session", cwd: folder, source: "startup" }),
      env: { REASONIX_HOME: scratch(), OPENCADRE_HOOK_HOME: home, HOME: home, USERPROFILE: home, OPENCADRE_URL: "", OPENCADRE_KEY: "" },
    });
    expect(calls.map((c) => ({ file: c.file, script: path.basename(c.args[0] ?? ""), windowsHide: c.windowsHide })))
      .toEqual([{ file: process.execPath, script: "opencadre-awareness.mjs", windowsHide: true }]);
  });

  it("the DeepSeek shell guard's command run", async () => {
    const guard = pathToFileURL(path.join(ROOT, "scripts", "deepseek-shell-guard.mjs")).href;
    const calls = await recorded(["--input-type=module", "-e", `const m = await import(${JSON.stringify(guard)}); await m.execCommand(process.cwd(), "echo hidden");`], { cwd: scratch() });
    expect(calls.filter((c) => c.fn === "execFile").map((c) => ({ args: c.args, windowsHide: c.windowsHide })))
      .toEqual([{ args: ["-c", "echo hidden"], windowsHide: true }]);
  });

  it("the wake daemon's resume and inject-items spawns (a detached daemon has no console to pass on)", async () => {
    // The CLI each adapter drives is node itself here: the run fails fast, but the spawn and its options are real.
    const t3 = pathToFileURL(path.join(ROOT, "scripts", "wake-daemon", "t3-resume.mjs")).href;
    const inject = pathToFileURL(path.join(ROOT, "scripts", "wake-daemon", "inject-items.mjs")).href;
    const node = JSON.stringify(process.execPath);
    const calls = await recorded(["--input-type=module", "-e", [
      `const t = await import(${JSON.stringify(t3)});`,
      `const i = await import(${JSON.stringify(inject)});`,
      `await t.claudeResumeAdapter({ command: ${node}, timeoutMs: 10000 }).wake({ sessionId: "s1", threadId: "s1" }, { line: "x" });`,
      `await i.codexInjectItemsAdapter({ command: ${node}, stateDir: ${JSON.stringify(scratch())} }).wake({ threadId: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000" }, { line: "x", ids: [] });`,
    ].join("\n")], { cwd: scratch() });
    expect(calls.map((c) => ({ fn: c.fn, first: c.args[0], windowsHide: c.windowsHide })))
      .toEqual([{ fn: "spawn", first: "-p", windowsHide: true }, { fn: "spawn", first: "app-server", windowsHide: true }]);
  });

  it("the inbox watcher's wake prompt build", async () => {
    const dir = scratch();
    const prompt = pathToFileURL(path.join(ROOT, "scripts", "webhook-wake-prompt.mjs")).href;
    const calls = await recorded(["--input-type=module", "-e", `const m = await import(${JSON.stringify(prompt)}); m.buildWakePrompt();`], {
      cwd: dir,
      env: { OPENCADRE_DISPLAY_PATH: path.join(dir, "display.jsonl"), OPENCADRE_AGENT_WAKE_PATH: path.join(dir, "wake.jsonl") },
    });
    expect(calls.map((c) => ({ file: c.file, script: path.basename(c.args[0] ?? ""), windowsHide: c.windowsHide })))
      .toEqual([{ file: "node", script: "agent-inbox-prompt.mjs", windowsHide: true }]);
  });
});
