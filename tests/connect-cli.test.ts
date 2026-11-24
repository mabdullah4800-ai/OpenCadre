import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { HELPERS, installedText, installManifestPath } from "../cli/lib/helpers.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { tmpDir } from "./helpers/tmp.js";

// The CLI redeems many codes from 127.0.0.1 in this file; lift the per-IP limit before the app loads.
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const { app } = await import("../src/rest.js");
const { createOrganization, registerAgent } = await import("../src/service.js");
const { assignPlan } = await import("../src/billing.js");
const { db } = await import("../src/db.js");
const { hashKey } = await import("../src/auth.js");

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const EMPTY_PATH = tmpDir("oc-cli-path-");

let server: http.Server;
let hub: string;
let operatorKey: string;
let cliOrgId: string;
let orgName: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  hub = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  orgName = "CLI Org";
  const { orgId } = createOrganization(orgName);
  operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
  cliOrgId = orgId;
  // UNCAPPED PLAN FOR THE FIXTURE, and it is a correctness fix rather than a way to make a red green
  // (9d1f's ruling). This suite shares ONE org and mints ~37 connect codes into it, so a fresh org's
  // TRIAL caps would refuse from the 11th agent on -- the limit working correctly, and this fixture
  // hitting it accidentally. A test that fails because its own fixture exhausted a plan measures the
  // fixture, not the code. The refusal itself is tested deliberately elsewhere, on a CAPPED org, where
  // the cap IS the thing under test.
  //
  // `internal` is the right plan for a fixture: it is the non-expiring, uncapped one (migration 29's
  // design), so the fixture can never hit a later limit or lapse mid-run either.
  assignPlan(orgId, "internal");
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let nameCounter = 0;
async function newCode(client = "auto") {
  const agentName = `Cli-Agent-${++nameCounter}`;
  const res = await fetch(`${hub}/v1/connect-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ agentName, client }),
  });
  const { code } = await res.json();
  return { code: code as string, agentName };
}

const status = async (code: string) =>
  (await fetch(`${hub}/v1/connect-codes/${code}/status`, { headers: { authorization: `Bearer ${operatorKey}` } })).json();

// The API key only ever comes back from redeem, so tests learn it from the config the CLI wrote.
const keyIn = (text: string) => text.match(/agt_[0-9a-f]{48}/)?.[0] ?? "";

/** Runs a script asynchronously: the hub runs in this process, so a sync spawn would deadlock it.
 * PATH points at an empty folder so no real claude/gemini CLI on this machine is found or touched. */
function run(script: string, args: string[], extraEnv: Record<string, string> = {}, cwd?: string, input?: string): Promise<{ code: number | null; out: string; err: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // No Claude Code session ids or real Windows app-data path from the developer's machine.
    if (v !== undefined && !["PATH", "APPDATA", "LOCALAPPDATA"].includes(k.toUpperCase()) && !k.startsWith("OPENCADRE_") && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
  }
  // A synthetic --home must not discover real Windows app installs through inherited APPDATA.
  const homeArg = args.indexOf("--home");
  const isolatedHome = homeArg >= 0 ? args[homeArg + 1] : extraEnv.OPENCADRE_HOOK_HOME ?? tmpDir("oc-cli-appdata-");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...env, PATH: EMPTY_PATH, APPDATA: path.join(isolatedHome, "AppData", "Roaming"), LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"), ...extraEnv }, ...(cwd ? { cwd } : {}) });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const connect = (home: string, code: string, ...extra: string[]) => run(CLI, ["connect", "--hub", hub, "--code", code, "--home", home, ...extra]);
const tempHome = () => tmpDir("oc-cli-home-");
// A Cursor installation must be represented independently of files written by connect.
function markCursorInstalled(home: string) {
  const config = path.join(home, ".cursor", "cli-config.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, "{}");
}
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

/** Seed legacy bytes and keep a real watcher alive for the reconnect preservation check. */
async function withLiveLegacyInstall(home: string, check: (pid: number) => Promise<void>) {
  const bin = path.join(home, ".opencadre", "bin");
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  for (const name of Object.keys(HELPERS)) {
    const file = path.join(bin, ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, installedText(name));
  }
  writeFileSync(installManifestPath(bin), JSON.stringify({ cliVersion: "0.1.0", stamp: "000000000000", installedAt: "2026-09-01T00:00:00Z", helpers: Object.fromEntries(Object.keys(HELPERS).map((name) => [name, digest(installedText(name)).slice(0, 12)])) }));
  writeFileSync(path.join(bin, "user-owned.bin"), Buffer.from([0, 255, 10, 13]));
  const snapshot = () => Object.fromEntries(allFiles(bin).map((file) => [path.relative(bin, file), digest(readFileSync(file))]));
  const before = snapshot();
  // A process that, like a watcher, is node running opencadre-wake.mjs from an install's bin: the inventory counts a
  // lock's pid only while that process is a wake watcher (a reused pid is not one).
  const fakeWatcher = path.join(tmpDir("oc-cli-fake-watcher-"), ".opencadre", "bin", "opencadre-wake.mjs");
  mkdirSync(path.dirname(fakeWatcher), { recursive: true });
  writeFileSync(fakeWatcher, "setTimeout(() => {}, 120000);\n");
  const sleeper = spawn(process.execPath, [fakeWatcher], { windowsHide: true });
  await once(sleeper, "spawn");
  try {
    writeFileSync(path.join(home, ".opencadre", "wake-0123456789abcdef.lock"), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() }));
    await check(sleeper.pid!);
    expect(snapshot()).toEqual(before);
    expect(existsSync(path.join(bin, ".gen"))).toBe(false);
  } finally {
    if (sleeper.exitCode === null && sleeper.signalCode === null) {
      const exited = once(sleeper, "exit");
      sleeper.kill();
      await exited;
    }
  }
}

/** The key may live only in the one client config it was written to: never in stdout, hooks, helpers or file names. */
function expectKeyConfined(home: string, key: string, configFile: string, output: string) {
  expect(key).toMatch(/^agt_/);
  expect(output).not.toContain(key);
  const holders = allFiles(home).filter((f) => readFileSync(f, "utf8").includes(key));
  expect(holders).toEqual([configFile]);
  for (const f of allFiles(home)) expect(path.basename(f)).not.toContain(key);
}

/** Enough TOML checking to catch what a line-based merge can break: duplicate tables and malformed lines. */
function expectSaneToml(text: string) {
  const headers: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const header = t.match(/^\[([^[\]]+)\]$/);
    if (header) {
      headers.push(header[1].trim());
      continue;
    }
    expect(t).toMatch(/^[\w"'.-]+\s*=\s*("[^"]*"|'[^']*'|\d+|true|false|\[.*\]|\{.*\})$/);
  }
  expect(new Set(headers).size).toBe(headers.length);
  return headers;
}

/** The lines belonging to one table and its subtables, header lines excluded.
 *
 * Needed because "the key is not in the config" is the WRONG assertion: the key legitimately lives in
 * [mcp_servers.opencadre]'s http_headers. The exposure §9 item 8 is about is narrower — the key must
 * not be inside the SHELL ENVIRONMENT section, which is forwarded to every command the model runs.
 * So this reads one section rather than the whole file, and a whole-file `not.toContain` would have
 * been a false red on a correct config. */
function sectionBody(text: string, name: string) {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^[\]]+)\]\s*$/.exec(line);
    if (header) inside = header[1] === name || header[1].startsWith(`${name}.`);
    else if (inside) out.push(line);
  }
  return out.join("\n");
}

const awarenessHooks = (hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>) =>
  Object.values(hooks).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes("opencadre-awareness.mjs"));

describe("opencadre connect: codex", () => {

  it("named-agent connect holds live legacy helpers, completes setup, and warns on both streams", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const { code, agentName } = await newCode("codex");
    await withLiveLegacyInstall(home, async (pid) => {
      const r = await connect(home, code, "--client", "codex");
      expect(r.code).toBe(0);
      for (const output of [r.out, r.err]) {
        expect(output).toContain("were NOT updated");
        expect(output).toContain(`wake watcher pid ${pid}`);
        expect(output).toContain("connect --upgrade");
      }
      expect(r.out).toContain(agentName);
      const config = path.join(home, ".codex", "config.toml");
      expect(readFileSync(config, "utf8")).toContain("[mcp_servers.opencadre]");
      expect(readJson(path.join(home, ".codex", "hooks.json")).hooks.PreToolUse.length).toBeGreaterThan(0);
      expectKeyConfined(home, keyIn(readFileSync(config, "utf8")), config, r.out + r.err);
    });
  }, 60_000);
  it("writes valid TOML with no duplicate tables on re-run, installs helpers and hooks", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(configFile));
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.node_repl]",
      'command = "node_repl.exe"',
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      'NODE_REPL_NODE_PATH = "node.exe"',
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      "",
      "[desktop]",
      "enabled = true",
      "",
    ].join("\n");
    writeFileSync(configFile, original);

    const first = await newCode("codex");
    const r1 = await connect(home, first.code, "--client", "codex");
    expect(r1.err).toBe("");
    expect(r1.code).toBe(0);
    const key1 = keyIn(readFileSync(configFile, "utf8"));

    const second = await newCode("codex");
    // Switching this machine's Codex to another agent is deliberate: --replace (without it the CLI refuses).
    const r2 = await connect(home, second.code, "--client", "codex", "--replace");
    expect(r2.code).toBe(0);
    const text = readFileSync(configFile, "utf8");
    const key2 = keyIn(text);
    expect(key2).not.toBe(key1);
    expect(text).not.toContain(key1);

    const headers = expectSaneToml(text);
    expect(headers.filter((h) => h === "mcp_servers.opencadre")).toHaveLength(1);
    for (const kept of ["mcp_servers.node_repl", "mcp_servers.node_repl.env", "shell_environment_policy", "desktop"]) expect(headers).toContain(kept);
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain(`url = "${hub}/mcp"`);
    expect(text).toContain(`http_headers = { "Authorization" = "Bearer ${key2}" }`);
    expect(text).toContain("tool_timeout_sec = 300");

    // THE KEY IS NOT PUT IN THE SHELL ENVIRONMENT (§9 item 8, 2026-09-20). Everything under
    // [shell_environment_policy.set] is forwarded to every command Codex runs, so writing the agent
    // key there made it readable by any `env` the model executed. This used to assert the opposite --
    // the pair WAS written -- and that assertion is what the change retires.
    //
    // Asserted on the SECTION, not the whole file: the key legitimately appears in the server table's
    // http_headers, which is where every consumer reads it from instead. A bare
    // `expect(text).not.toContain(key2)` would fail on a correct file.
    const shellEnv = sectionBody(text, "shell_environment_policy");
    expect(shellEnv).not.toMatch(/OPENCADRE_(URL|KEY)/);
    // And an install that never had the table does not gain one.
    expect(headers).not.toContain("shell_environment_policy.set");

    const backups = readdirSync(path.dirname(configFile)).filter((f) => f.startsWith("config.toml.bak-"));
    expect(backups).toHaveLength(2);
    expect(backups.map((b) => readFileSync(path.join(home, ".codex", b), "utf8"))).toContain(original);

    const bin = path.join(home, ".opencadre", "bin");
    const { hooks } = readJson(path.join(home, ".codex", "hooks.json"));
    const ours = awarenessHooks(hooks);
    expect(ours).toHaveLength(4);
    for (const h of ours) expect(h.command).toBe(`node "${path.join(bin, "opencadre-awareness.mjs")}" --client codex`);

    expect(r2.out).toContain(`Connected as ${second.agentName} in ${orgName} via codex`);
    expect(r2.out).toMatch(/\/hooks/);
    expect(r2.out).toContain("Each agent needs its own working folder");
    expectKeyConfined(home, key2, configFile, r1.out + r1.err + r2.out + r2.err);
  }, 30_000);

  it("replaces an existing opencadre table and its subtables instead of duplicating them", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(configFile));
    writeFileSync(configFile, [
      "[mcp_servers.opencadre]",
      'url = "https://old.example/mcp"',
      'http_headers = { "Authorization" = "Bearer agt_old" }',
      "",
      "[mcp_servers.opencadre.env]",
      'X = "1"',
      "",
      "[shell_environment_policy.set]",
      'OPENCADRE_KEY = "agt_old"',
      'OTHER = "kept"',
      "",
    ].join("\n"));
    const { code } = await newCode();
    expect((await connect(home, code, "--client", "codex", "--replace")).code).toBe(0);
    const text = readFileSync(configFile, "utf8");
    const headers = expectSaneToml(text);
    expect(headers.sort()).toEqual(["mcp_servers.opencadre", "shell_environment_policy.set"]);
    expect(text).not.toContain("old.example");
    expect(text).not.toContain("agt_old");
    // `OTHER` is not ours, so the table survives carrying it -- the point of this test. What changed
    // (§9 item 8): OpenCadre's own key is NOT written back into it, and the stale one is removed.
    expect(text).toContain('OTHER = "kept"');
    expect(sectionBody(text, "shell_environment_policy")).not.toMatch(/OPENCADRE_(URL|KEY)/);
    // The new key is in the SERVER TABLE, which is where every consumer reads it from.
    expect(text).toContain('http_headers = { "Authorization" = "Bearer ');
  }, 30_000);
});

describe("opencadre connect: JSON clients", () => {
  it("merges cursor's mcp.json, auto-detected, keeping existing servers", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".cursor", "mcp.json");
    mkdirSync(path.dirname(configFile));
    markCursorInstalled(home);
    writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { url: "https://other.example/mcp" } }, theme: "dark" }));
    const { code, agentName } = await newCode();
    const r = await connect(home, code);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const config = readJson(configFile);
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ url: "https://other.example/mcp" });
    const key = keyIn(config.mcpServers.opencadre.headers.Authorization);
    expect(config.mcpServers.opencadre).toEqual({ url: `${hub}/mcp`, headers: { Authorization: `Bearer ${key}` } });
    expect(r.out).toContain(`Connected as ${agentName} in ${orgName} via cursor`);
    expectKeyConfined(home, key, configFile, r.out + r.err);
  }, 30_000);

  it("merges antigravity's mcp_config.json with serverUrl and installs global inbox hooks without touching any repo", async () => {
    const home = tempHome();
    // The documented file (~/.gemini/config); the vendor calls ~/.gemini/antigravity "legacy" (HARNESS-ANTIGRAVITY.md G4).
    const configFile = path.join(home, ".gemini", "config", "mcp_config.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ mcpServers: { github: { serverUrl: "https://gh.example/mcp" } } }));
    const { code } = await newCode("antigravity");
    const r = await connect(home, code, "--client", "antigravity", "--verbose");
    expect(r.code).toBe(0);
    const config = readJson(configFile);
    expect(config.mcpServers.github).toEqual({ serverUrl: "https://gh.example/mcp" });
    const key = keyIn(config.mcpServers.opencadre.headers.Authorization);
    expect(config.mcpServers.opencadre).toEqual({ serverUrl: `${hub}/mcp`, headers: { Authorization: `Bearer ${key}` } });

    const hooksFile = path.join(home, ".gemini", "config", "hooks.json");
    const hooks = readJson(hooksFile);
    const scriptPath = path.join(home, ".opencadre", "bin", "opencadre-antigravity.mjs");
    expect(hooks["opencadre-inbox"]).toEqual({
      enabled: true,
      PreInvocation: [{ type: "command", command: `node "${scriptPath}" pre-invocation`, timeout: 10 }],
      Stop: [{ type: "command", command: `node "${scriptPath}" stop`, timeout: 10 }],
    });
    expect(r.out).toContain(hooksFile);
    expect(r.out).toContain("global");
    // Never touched a project checkout: no .agent/ or .agents/ folder appears anywhere under home.
    expect(existsSync(path.join(home, ".agent"))).toBe(false);
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(false);
    expectKeyConfined(home, key, configFile, r.out + r.err);
  }, 30_000);

  it("merges an existing global antigravity hooks.json without disturbing unrelated hooks, and backs it up", async () => {
    const home = tempHome();
    const hooksFile = path.join(home, ".gemini", "config", "hooks.json");
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ "my-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } }));
    const { code } = await newCode("antigravity");
    const r = await connect(home, code, "--client", "antigravity", "--verbose");
    expect(r.code).toBe(0);
    const hooks = readJson(hooksFile);
    expect(hooks["my-linter"]).toEqual({ PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] });
    expect(hooks["opencadre-inbox"].enabled).toBe(true);
    expect(r.out).toMatch(/previous version kept as/);
  }, 30_000);

  it("re-running antigravity connect refreshes the hook path in place instead of duplicating it", async () => {
    const home = tempHome();
    const first = await newCode("antigravity");
    await connect(home, first.code, "--client", "antigravity");
    const second = await newCode("antigravity");
    const r = await connect(home, second.code, "--client", "antigravity", "--replace");
    expect(r.code).toBe(0);
    const hooks = readJson(path.join(home, ".gemini", "config", "hooks.json"));
    // The inbox and the clearance gate, each once.
    expect(Object.keys(hooks)).toEqual(["opencadre-inbox", "opencadre-gate"]);
    expect(hooks["opencadre-inbox"].PreInvocation).toHaveLength(1);
    expect(hooks["opencadre-inbox"].Stop).toHaveLength(1);
    expect(hooks["opencadre-gate"].PreToolUse).toHaveLength(1);
    expect(hooks["opencadre-gate"].PreToolUse[0].hooks).toHaveLength(1);
  }, 30_000);

  // G2. The protocol the hook injects tells the agent to read its full rules, and the rule carries the
  // watcher instructions. Connect installed neither: it wrote MCP config and hooks only, so the rule the
  // agent was pointed at existed only inside this repository. It is now installed into the global
  // ~/.gemini/GEMINI.md as a marked block.
  it("installs the inbox rule as a marked block in the global GEMINI.md, and never overwrites the rest", async () => {
    const home = tempHome();
    const rulesFile = path.join(home, ".gemini", "GEMINI.md");
    mkdirSync(path.dirname(rulesFile), { recursive: true });
    writeFileSync(rulesFile, "# My own global rules\n\nAlways answer in French.\n");
    const { code } = await newCode("antigravity");
    const r = await connect(home, code, "--client", "antigravity");
    expect(r.code).toBe(0);
    const text = readFileSync(rulesFile, "utf8");
    // The user's own content survives, in place.
    expect(text).toContain("# My own global rules");
    expect(text).toContain("Always answer in French.");
    // The rule is present, marked, and names the installed watcher.
    expect(text).toContain("OpenCadre inbox discipline");
    expect(text).toMatch(/<!--\s*opencadre:begin/);
    expect(text).toMatch(/<!--\s*opencadre:end\s*-->/);
    expect(text).toContain(path.join(home, ".opencadre", "bin", "opencadre-wake.mjs"));
    expect(text).not.toContain("node scripts/opencadre-wake.mjs");
  }, 30_000);

  it("re-running antigravity connect replaces its own rules block instead of stacking copies", async () => {
    const home = tempHome();
    const rulesFile = path.join(home, ".gemini", "GEMINI.md");
    const first = await newCode("antigravity");
    await connect(home, first.code, "--client", "antigravity");
    const second = await newCode("antigravity");
    const r = await connect(home, second.code, "--client", "antigravity", "--replace");
    expect(r.code).toBe(0);
    const text = readFileSync(rulesFile, "utf8");
    expect(text.match(/OpenCadre inbox discipline/g)).toHaveLength(1);
    expect(text.match(/<!--\s*opencadre:begin/g)).toHaveLength(1);
  }, 30_000);

  // The global GEMINI.md is the one file here a customer cannot recover with a fresh checkout, so the
  // re-run has to be safe against a hand-edited block as well as an untouched one: a stale copy of our
  // own rule (an older watcher path, say) must be replaced, and the customer's own text must not move.
  it("replaces a hand-edited rules block, keeps everything outside it, and backs the file up", async () => {
    const home = tempHome();
    const rulesFile = path.join(home, ".gemini", "GEMINI.md");
    mkdirSync(path.dirname(rulesFile), { recursive: true });
    const first = await newCode("antigravity");
    await connect(home, first.code, "--client", "antigravity");

    // Simulate a customer who edited inside our block and added their own text around it.
    const installed = readFileSync(rulesFile, "utf8");
    const stale = installed.replace(/node "[^"]*opencadre-wake\.mjs"/, 'node "/gone/old-path/opencadre-wake.mjs"');
    writeFileSync(rulesFile, `# Before the block\n\nKEEP ME ABOVE\n\n${stale}\nKEEP ME BELOW\n`);

    const second = await newCode("antigravity");
    const r = await connect(home, second.code, "--client", "antigravity", "--replace");
    expect(r.code).toBe(0);
    const text = readFileSync(rulesFile, "utf8");
    // The stale path is gone and the current one is in: a hand edit cannot pin an old install.
    expect(text).not.toContain("/gone/old-path/");
    expect(text).toContain(path.join(home, ".opencadre", "bin", "opencadre-wake.mjs"));
    // Exactly one block, and the customer's text on both sides is intact and still in order.
    expect(text.match(/<!--\s*opencadre:begin/g)).toHaveLength(1);
    expect(text.match(/<!--\s*opencadre:end/g)).toHaveLength(1);
    expect(text).toContain("KEEP ME ABOVE");
    expect(text).toContain("KEEP ME BELOW");
    expect(text.indexOf("KEEP ME ABOVE")).toBeLessThan(text.indexOf("OpenCadre inbox discipline"));
    expect(text.indexOf("OpenCadre inbox discipline")).toBeLessThan(text.indexOf("KEEP ME BELOW"));
    // The hand-edited version is recoverable.
    expect(readdirSync(path.dirname(rulesFile)).some((f) => f.startsWith("GEMINI.md.bak-"))).toBe(true);
  }, 30_000);

  // G5. Detection keyed only on ~/.gemini/antigravity, the app data dir the desktop apps and the IDE
  // create. A CLI-only install has ~/.gemini/antigravity-cli (or just `agy` on PATH) and was reported as
  // "no clients found".
  it("detects an Antigravity CLI-only install from its own folder and from agy on PATH", async () => {
    // ~/.gemini/antigravity-cli, which only the CLI creates.
    const cliOnly = tempHome();
    mkdirSync(path.join(cliOnly, ".gemini", "antigravity-cli"), { recursive: true });
    const r = await connect(cliOnly, (await newCode("antigravity")).code, "--client", "antigravity");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Connected as");

    // agy on PATH alone is enough for detection: --client auto must pick antigravity rather than
    // report that it found no client. The code is redeemed only if detection succeeded.
    const onPath = tempHome();
    const fakeBin = mkdtempSync(path.join(tmpdir(), "ag-bin-"));
    // findOnPath (cli/lib/clients.mjs) appends .exe/.cmd only on win32, so the binary has to be
    // spelled the way THIS platform installs it. A fixed "agy.exe" made this test pass on Windows
    // and fail on macOS and Linux, which is what #305 reported as a detection regression.
    writeFileSync(path.join(fakeBin, process.platform === "win32" ? "agy.exe" : "agy"), "");
    const { code } = await newCode("antigravity");
    const detected = await run(CLI, ["connect", "--hub", hub, "--code", code, "--home", onPath], { PATH: fakeBin });
    expect(detected.code, detected.err).toBe(0);
    expect(detected.out).toContain("Connected as");
    expect(existsSync(path.join(onPath, ".gemini", "config", "mcp_config.json"))).toBe(true);
  }, 30_000);

  it("merges gemini's settings.json with httpUrl", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".gemini", "settings.json");
    mkdirSync(path.dirname(configFile));
    writeFileSync(configFile, JSON.stringify({ theme: "GitHub" }));
    const { code } = await newCode();
    const r = await connect(home, code);
    expect(r.code).toBe(0);
    const config = readJson(configFile);
    expect(config.theme).toBe("GitHub");
    expect(config.mcpServers.opencadre.httpUrl).toBe(`${hub}/mcp`);
  }, 30_000);

  // OpenCode v2 keeps its global config at ~/.config/opencode/opencode.json, nesting servers under
  // `mcp.servers.<name>` with `type: "remote"` (MEASURED against v2.0.10 on 2026-09-19 - the flat
  // `mcp.<name>` shape is not read; docs/design/HARNESS-OPENCODE-IDENTITY.md). The CLI must detect it
  // from that folder and write the entry without touching the neighbours.
  it("merges opencode's opencode.json, auto-detected from its config folder", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-sonnet-4-5", mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } } } }));
    const { code, agentName } = await newCode();
    const r = await connect(home, code);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const config = readJson(configFile);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.mcp.servers.context7).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" });
    const key = keyIn(config.mcp.servers.opencadre.headers.Authorization);
    expect(config.mcp.servers.opencadre).toEqual({ type: "remote", url: `${hub}/mcp`, headers: { Authorization: `Bearer ${key}` } });
    expect(r.out).toContain(`Connected as ${agentName} in ${orgName} via opencode`);
    expectKeyConfined(home, key, configFile, r.out + r.err);
  }, 30_000);

  it("refuses to spend the code when opencode's config is JSONC, rather than delete the comments", async () => {
    const home = tempHome();
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const jsoncFile = path.join(dir, "opencode.jsonc");
    writeFileSync(jsoncFile, `{\n  // keep my notes\n  "mcp": {}\n}\n`);
    const { code } = await newCode();
    const r = await connect(home, code);
    expect(r.code).toBe(1);
    expect(r.err).toContain("opencode.jsonc");
    expect(r.err).toContain("comments");
    expect(readFileSync(jsoncFile, "utf8")).toContain("// keep my notes");
    expect((await status(code)).state).toBe("pending");
  }, 30_000);

  it("merges ~/.claude.json when the claude CLI isn't on PATH, and installs session hooks", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".claude.json");
    writeFileSync(configFile, JSON.stringify({ projects: { "/work": { mcpServers: {} } }, mcpServers: { other: { type: "stdio", command: "x" } } }));
    const { code, agentName } = await newCode();
    const r = await connect(home, code);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const config = readJson(configFile);
    expect(config.projects).toEqual({ "/work": { mcpServers: {} } });
    expect(config.mcpServers.other).toEqual({ type: "stdio", command: "x" });
    const key = keyIn(config.mcpServers.opencadre.headers.Authorization);
    expect(config.mcpServers.opencadre).toEqual({ type: "http", url: `${hub}/mcp`, headers: { Authorization: `Bearer ${key}` } });
    const settings = readJson(path.join(home, ".claude", "settings.json"));
    expect(awarenessHooks(settings.hooks)).toHaveLength(4);
    const wakePath = path.join(home, ".opencadre", "bin", "opencadre-wake.mjs");
    expect(settings.hooks.Stop[0].hooks[1]).toEqual({ type: "command", command: `node "${wakePath}" --rewake --client claude-code`, asyncRewake: true, timeout: 604800 });
    const gatePath = path.join(home, ".opencadre", "bin", "opencadre-approval-gate.mjs");
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: `node "${gatePath}" --client claude-code`, timeout: 600 }] }]);

    // R4 unit 1: the installed gate finds the hub and key in ~/.claude.json alone and records a risky command
    // (notify mode: never blocks) as a clearance event the operator sees.
    // Async spawn: this test process also hosts the hub, so a sync spawn would block the gate's own request.
    const gateRun = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [gatePath, "--client", "claude-code"], {
        env: { ...process.env, OPENCADRE_HOOK_HOME: home, HOME: home, USERPROFILE: home, OPENCADRE_URL: "", OPENCADRE_KEY: "", OPENCADRE_GATE_MODE: "" },
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ./dist-old" }, cwd: home }));
    });
    expect(gateRun.code).toBe(0);
    expect(gateRun.out).toBe("");
    const noted = await (await fetch(`${hub}/v1/approvals?status=noted`, { headers: { authorization: `Bearer ${operatorKey}` } })).json();
    expect(JSON.stringify(noted)).toContain("rm -rf ./dist-old");
    expect(r.out).not.toMatch(/\/hooks/);
    expectKeyConfined(home, key, configFile, r.out + r.err);

    // The installed wake script finds the hub and key in ~/.claude.json alone, with no env vars.
    await fetch(`${hub}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agentName, body: "Please review the connect PR" }),
    });
    const woke = await run(wakePath, ["--client", "claude-code"], { OPENCADRE_HOOK_HOME: home, OPENCADRE_WAKE_STATE_DIR: tempHome(), OPENCADRE_WAIT_SECONDS: "1" });
    expect(woke.out).toContain("OPENCADRE WAKE: 1 new message(s)");
    expect(woke.out + woke.err).not.toContain(key);
  }, 30_000);
});

describe("opencadre connect --project (a second Claude Code agent on one machine)", () => {
  // Found live: connect wrote every Claude Code key user-wide, so onboarding a second session on the
  // same PC replaced the first agent's identity. --project scopes the key to one folder instead.
  it("writes the key for that folder only and leaves the user-wide agent untouched", async () => {
    const home = tempHome();
    const project = mkdtempSync(path.join(tmpdir(), "oc-cli-project-"));
    const configFile = path.join(home, ".claude.json");
    const existing = { type: "http", url: `${hub}/mcp`, headers: { Authorization: "Bearer agt_existing" } };
    writeFileSync(configFile, JSON.stringify({ mcpServers: { opencadre: existing } }));
    const { code } = await newCode();
    const r = await connect(home, code, "--client", "claude-code", "--project", project);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);

    const config = readJson(configFile);
    expect(config.mcpServers.opencadre).toEqual(existing);
    const projects = Object.entries(config.projects) as Array<[string, { mcpServers: { opencadre: { headers: { Authorization: string } } } }]>;
    expect(projects).toHaveLength(1);
    // The stored key is the REAL (symlink-resolved) path, not just path.resolve()'s lexical form --
    // on macOS /tmp and /var are themselves symlinks, and the reader side resolves symlinks too
    // (fix/named-agent-symlink-path), so writer and reader must agree on this canonical form. On
    // Windows a brand-new entry is written with forward slashes (existing convention, "as current
    // Claude Code does"), so normalize the expectation the same way before comparing.
    const expectedKey = process.platform === "win32"
      ? realpathSync.native(path.resolve(project)).replace(/\\/g, "/")
      : realpathSync.native(path.resolve(project));
    expect(projects[0][0].toLowerCase()).toBe(expectedKey.toLowerCase());
    const key = keyIn(projects[0][1].mcpServers.opencadre.headers.Authorization);
    expect(key).not.toBe("");
    expect(r.out).toContain(project);
    expectKeyConfined(home, key, configFile, r.out + r.err);

    // Hooks and the wake script resolve the new agent only from inside its folder.
    const { resolveHub } = await import("../scripts/opencadre-config.mjs");
    expect(resolveHub({ client: "claude-code", home, cwd: project, env: {} }).key).toBe(key);
    expect(resolveHub({ client: "claude-code", home, cwd: home, env: {} }).key).toBe("agt_existing");
  }, 30_000);

  it("is refused for clients whose MCP config is user-wide, before the code is spent", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const { code } = await newCode();
    const r = await connect(home, code, "--client", "codex", "--project", tempHome());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--project/);
    expect((await status(code)).state).toBe("pending");
  }, 30_000);
});

describe("opencadre connect --code ocd_ (connect a machine: every session gets its own identity)", () => {
  let machineCounter = 0;
  async function newMachineCode(client = "claude-code") {
    const res = await fetch(`${hub}/v1/org/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `Machine ${++machineCounter}`, client }),
    });
    return (await res.json()) as { deviceId: string; code: string };
  }
  /** The org's projects as the console's Fleet -> Projects tab reads them. */
  const projectsOnHub = async () => {
    const { projects } = await (await fetch(`${hub}/v1/org/projects`, { headers: { authorization: `Bearer ${operatorKey}` } })).json() as { projects: Array<{ projectKey: string; name: string; enabled: boolean }> };
    return projects;
  };

  const machine = async (deviceId: string) => {
    const { devices } = await (await fetch(`${hub}/v1/org/devices`, { headers: { authorization: `Bearer ${operatorKey}` } })).json() as { devices: Array<{ deviceId: string; status: string; sessionCount: number }> };
    return devices.find((d) => d.deviceId === deviceId)!;
  };


  it("computer connect holds live legacy helpers, completes Codex setup, and prints a stamped recovery command", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const pkg = path.join(tmpDir("oc-cli-held-pkg-"), "opencadre-cli.tgz");
    writeFileSync(pkg, "held-conversion recovery URL fixture");
    const stamp = createHash("sha256").update(readFileSync(pkg)).digest("hex").slice(0, 12);
    const previousPackage = process.env.OPENCADRE_CLI_TARBALL;
    process.env.OPENCADRE_CLI_TARBALL = pkg;
    try {
      const { deviceId, code } = await newMachineCode("auto");
      await withLiveLegacyInstall(home, async (pid) => {
        const r = await connect(home, code, "--client", "codex");
        expect(r.code).toBe(0);
        for (const output of [r.out, r.err]) {
          expect(output).toContain("were NOT updated");
          expect(output).toContain(`wake watcher pid ${pid}`);
          expect(output).toContain(`npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`);
          expect(output).not.toContain("/cli/opencadre-cli.tgz");
        }
        const { computer } = readJson(path.join(home, ".opencadre", "credentials.json"));
        expect(computer.deviceId).toBe(deviceId);
        expect(r.out + r.err).not.toContain(computer.credential);
        expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.opencadre-session]");
        expect(readJson(path.join(home, ".codex", "hooks.json")).hooks.PreToolUse.length).toBeGreaterThan(0);
        expect(await machine(deviceId)).toMatchObject({ status: "connected", sessionCount: 0 });
      });
    } finally {
      if (previousPackage === undefined) delete process.env.OPENCADRE_CLI_TARBALL;
      else process.env.OPENCADRE_CLI_TARBALL = previousPackage;
    }
  }, 60_000);

  it.each([false, true])("describes Claude mail without promising unmeasured idle wake (verbose=%s)", async (verbose) => {
    const home = tempHome();
    writeFileSync(path.join(home, ".claude.json"), "{}");
    const { code } = await newMachineCode();
    const r = await connect(home, code, "--client", "claude-code", ...(verbose ? ["--verbose"] : []));
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const full = readFileSync(path.join(home, ".opencadre", "last-connect.txt"), "utf8");
    // These are real CLI reports from a synthetic install, not a live Claude wake measurement.
    for (const report of [r.out, full]) {
      expect(report).not.toContain("Idle wake is on for Claude Code");
      expect(report).not.toContain("so new mail wakes an idle session");
      expect(report).toContain("session hooks, mail at turn end)");
      expect(report).toContain("Claude Code: next-turn mail was measured on a local hub.");
      expect(report).toContain("Idle wake in an interactive terminal and the current desktop app is not yet verified.");
      expect(report).toContain("The Stop hook installs opencadre-wake.mjs with asyncRewake");
    }
    // Correcting the promise must not disable the installed watcher or alter its timeout.
    const hooks = readJson(path.join(home, ".claude", "settings.json")).hooks;
    const wake = hooks.Stop.flatMap((group: { hooks: Array<Record<string, unknown>> }) => group.hooks)
      .filter((hook: { command?: string }) => hook.command?.includes("opencadre-wake.mjs"));
    expect(wake).toEqual([{
      type: "command",
      command: `node "${path.join(home, ".opencadre", "bin", "opencadre-wake.mjs")}" --rewake --client claude-code`,
      asyncRewake: true,
      timeout: 7 * 24 * 60 * 60,
    }]);
  }, 60_000);

  it("writes the credential only to credentials.json and a keyless opencadre-session stdio entry", async () => {
    const home = tempHome();
    const configFile = path.join(home, ".claude.json");
    const credentialsFile = path.join(home, ".opencadre", "credentials.json");
    writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } }, theme: "dark" }));
    mkdirSync(path.dirname(credentialsFile), { recursive: true });
    writeFileSync(credentialsFile, JSON.stringify({ devices: { reasonix: { hub: "http://elsewhere", credential: "kept-as-is" } }, note: "kept" }));
    const { code, deviceId } = await newMachineCode();

    const r = await connect(home, code, "--client", "claude-code");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);

    const credentials = readJson(credentialsFile);
    expect(credentials.note).toBe("kept");
    expect(credentials.devices.reasonix).toEqual({ hub: "http://elsewhere", credential: "kept-as-is" });
    const device = credentials.computer;
    expect(device).toMatchObject({ hub, deviceId });
    expect(device.credential).toMatch(/^dev_[0-9a-f]{48}$/);
    expect(readdirSync(path.dirname(credentialsFile)).filter((f) => f.startsWith("credentials.json.bak-"))).toHaveLength(1);

    const proxyPath = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
    const config = readJson(configFile);
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ type: "stdio", command: "x" });
    expect(config.mcpServers.opencadre).toBeUndefined();
    expect(config.mcpServers["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [proxyPath, "--client", "claude-code"] });
    expect(readFileSync(configFile, "utf8")).not.toContain("dev_");
    expect(existsSync(proxyPath)).toBe(true);

    const settingsFile = path.join(home, ".claude", "settings.json");
    expect(awarenessHooks(readJson(settingsFile).hooks)).toHaveLength(4);
    expect(readFileSync(settingsFile, "utf8")).not.toContain("dev_");

    // The credential is in exactly one file, and never in the output.
    expect(allFiles(home).filter((f) => readFileSync(f, "utf8").includes(device.credential))).toEqual([credentialsFile]);
    expect(r.out + r.err).not.toContain(device.credential);
    expect(r.out + r.err).not.toMatch(/dev_[0-9a-f]{8}/);

    expect(r.out).toContain(`Connected this computer to ${orgName}. Every chat in its tools gets its own name automatically, in the projects you enable.`);
    expect(r.out).toMatch(/Tools on this computer:\n {2}Claude Code {2}set up: every chat joins as its own session/);
    expect(r.out).toContain("show these to the user word for word");
    expect(r.out).toContain("A folder that has its own named OpenCadre agent keeps it");
    // The short form (2026-10-02): the file list, with every backup's path, is the full report's. What prints is how many
    // files, and that the changed ones were backed up (credentials.json and ~/.claude.json both existed here).
    const report = path.join(home, ".opencadre", "last-connect.txt");
    expect(r.out).not.toContain("Files written:");
    expect(r.out).toMatch(/\nSet up \d+ files; the previous version of each of the \d+ changed files was kept next to it, ending in \.bak-\d{4}-\d\d-\d\dT[\d-]+Z\.\n/);
    expect(r.out.trimEnd().split("\n").pop()).toBe(`Full report: ${report} (or add --verbose to print it here).`);
    const full = readFileSync(report, "utf8");
    expect(full).toContain("Files written:");
    expect(full).toContain(`${credentialsFile} (this computer's credential) (previous version kept as`);
    // (The credential itself is in credentials.json only: the allFiles() check above covers the report too.)
    // A plain terminal (no session ids): a restart, never "open a new session".
    expect(r.out).toContain("Restart Claude Code");
    expect(r.out).not.toMatch(/open a new (session|chat)/i);
    // #367: this block used to assert the OPPOSITE -- that a terminal connect enables no project and
    // tells the user to go do it in the console. That was the defect written down as the expectation.
    // Enabling is a device action (enableCurrentProject takes the credential and the project header,
    // no session hints), and the console's primary button hands over a command for a TERMINAL, so
    // gating it on a chat meant that path produced a working credential and a first chat with zero
    // tools -- answerAsEmptyServer, HTTP 200, nothing to notice. The folder is now enabled here too.
    expect(r.out).toContain("Enabled this project");
    expect(r.out).not.toContain("Enable the projects this computer should join in the console under Settings → Projects.");
    // The printed line is not the property that broke -- the hub's own state is. #367 measured a
    // first tools/list returning {"tools":[]} because no project row was enabled, so assert the row.
    const enabledOnHub = (await projectsOnHub()).filter((p) => p.enabled);
    expect(enabledOnHub).toHaveLength(1);
    expect(enabledOnHub[0].enabled).toBe(true);
    // Still the point of the original assertion, and the half that must not change: enabling a
    // project must not seat a session. A terminal has no chat to seat, so the join stays chat-only.
    expect(await machine(deviceId)).toMatchObject({ status: "connected", sessionCount: 0 });
  }, 60_000);

  it("run from a chat, joins that chat right away and says so, word for word", async () => {
    const home = tempHome();
    const folder = path.join(mkdtempSync(path.join(tmpdir(), "oc-cli-chat-")), "ChatRepo");
    mkdirSync(path.join(folder, ".git"), { recursive: true });
    const { code, deviceId } = await newMachineCode();
    const r = await run(CLI, ["connect", "--hub", hub, "--code", code, "--home", home, "--client", "claude-code"], { CLAUDE_CODE_SESSION_ID: "chat-tool-1", CLAUDE_CODE_HOST_SESSION_ID: "chat-host-1" }, folder);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const { sessions } = await (await fetch(`${hub}/v1/org/sessions`, { headers: { authorization: `Bearer ${operatorKey}` } })).json() as { sessions: Array<{ agentName: string; deviceId: string; tool: string | null; projectName: string | null }> };
    const joined = sessions.find((s) => s.deviceId === deviceId);
    const name = joined?.agentName ?? "";
    // The name is one word (sessions PR1); the chat's tool and project are the session's own fields.
    expect(name).toMatch(/^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/);
    expect(joined).toMatchObject({ tool: "claude-code", projectName: "ChatRepo" });
    expect(r.out).toContain(`This chat is now ${name}. It works right away through the opencadre commands (inbox, reply, send, status, wait).`);
    expect(r.out).toContain(`To get the full OpenCadre tools in this chat, restart Claude Code and come back to THIS SAME chat. Don't open a new one. It stays ${name}.`);
    expect(r.out).toContain("Chats you open later in this project join automatically with their own names; no restart needed.");
    expect(r.out).toMatch(new RegExp(`npx -y ${hub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/cli/(?:[0-9a-f]{12}/)?opencadre-cli\\.tgz inbox`));
    expect(r.out).not.toMatch(/open a new (session|chat)/i);
    expect(await machine(deviceId)).toMatchObject({ sessionCount: 1 });
    // Run from that chat, connect enabled the chat's project (a folder with no remote: local:ChatRepo), and only it.
    expect(r.out).toContain("Enabled this project: ChatRepo. Other projects on this computer stay off until you enable them in the console.");
    expect(db.prepare(`SELECT project_key, enabled, enabled_by_agent_name FROM projects WHERE org_id = ? AND project_key = 'local:chatrepo'`).get(cliOrgId))
      .toEqual({ project_key: "local:chatrepo", enabled: 1, enabled_by_agent_name: expect.stringMatching(/^Machine \d+$/) });
    // And wrote this computer's first copy of the enabled-project list (local opt-in), with the project just enabled on
    // it, so the hooks and MCP server name this folder to the hub and no other.
    const snapshot = JSON.parse(readFileSync(path.join(home, ".opencadre", "project-allowlist.json"), "utf8")) as Record<string, { projects: string[] }>;
    expect(Object.values(snapshot).map((slot) => slot.projects)).toEqual([expect.arrayContaining(["local:chatrepo"])]);
  }, 60_000);

  // Q1g: a re-run with NO code has no redeem answer to learn the CLI's stamp from, so it printed the bare package URL npx
  // had cached. It now takes the stamp from GET /v1/devices/me. The hub here has a package built (any bytes: only the
  // stamp matters), so the printed command must carry THAT stamp, in the path, and the bare form must not appear.
  it("a no-code re-run from a chat prints the stamped CLI URL it learned from /v1/devices/me", async () => {
    const pkg = path.join(tmpDir("oc-cli-rerun-pkg-"), "opencadre-cli.tgz");
    writeFileSync(pkg, `a built CLI package ${Date.now()}`);
    const stamp = createHash("sha256").update(readFileSync(pkg)).digest("hex").slice(0, 12);
    process.env.OPENCADRE_CLI_TARBALL = pkg;
    try {
      const home = tempHome();
      writeFileSync(path.join(home, ".claude.json"), "{}");
      const first = await newMachineCode("auto");
      expect((await connect(home, first.code)).code).toBe(0);
      const folder = path.join(tmpDir("oc-cli-rerun-chat-"), "RerunRepo");
      mkdirSync(path.join(folder, ".git"), { recursive: true });
      const r = await run(CLI, ["connect", "--home", home, "--client", "claude-code"], { CLAUDE_CODE_SESSION_ID: "rerun-tool-1", CLAUDE_CODE_HOST_SESSION_ID: "rerun-host-1" }, folder);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Run the commands as: npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz inbox`);
      expect(r.out).not.toContain("/cli/opencadre-cli.tgz");
    } finally {
      delete process.env.OPENCADRE_CLI_TARBALL;
    }
  }, 60_000);

  it("sets up every supported tool it finds with one credential: Claude Code and Codex configs hold none of it", async () => {
    const home = tempHome();
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ theme: "dark" }));
    mkdirSync(path.join(home, ".codex"));
    // A Codex config with a named agent's neighbour server and a shell policy of its own: both must stay as they are.
    const codexBefore = ["model = \"gpt-5\"", "", "[mcp_servers.github]", "command = \"gh-mcp\"", "", "[shell_environment_policy]", "inherit = \"core\""].join("\n");
    writeFileSync(path.join(home, ".codex", "config.toml"), `${codexBefore}\n`);
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code, deviceId } = await newMachineCode("auto");

    const r = await connect(home, code);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const credentialsFile = path.join(home, ".opencadre", "credentials.json");
    const { computer } = readJson(credentialsFile);
    expect(computer).toMatchObject({ hub, deviceId, credential: expect.stringMatching(/^dev_[0-9a-f]{48}$/) });
    expect(Object.keys(readJson(credentialsFile))).toEqual(["computer"]);

    const proxyPath = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
    expect(readJson(path.join(home, ".claude.json")).mcpServers["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [proxyPath, "--client", "claude-code"] });
    const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expectSaneToml(toml);
    expect(toml.startsWith(codexBefore)).toBe(true);
    expect(toml).toContain(["[mcp_servers.opencadre-session]", 'command = "node"', `args = [${JSON.stringify(proxyPath)}, "--client", "codex"]`, "tool_timeout_sec = 300"].join("\n"));
    expect(toml).not.toMatch(/OPENCADRE_(KEY|URL)|shell_environment_policy\.set|\[mcp_servers\.opencadre\]/);
    // The inbox skill and scheduled-task message, with no agent name baked in: the proxy names each chat.
    const skill = readFileSync(path.join(home, ".codex", "skills", "opencadre-inbox", "SKILL.md"), "utf8");
    expect(skill).toContain("opencadre-session");
    expect(skill).not.toContain("{{AGENT_NAME}}");
    expect(r.out).toContain(readFileSync(path.join(home, ".opencadre", "codex-inbox-setup.txt"), "utf8").trim());

    // The credential is in exactly one file, and never in the output.
    expect(allFiles(home).filter((f) => readFileSync(f, "utf8").includes(computer.credential))).toEqual([credentialsFile]);
    expect(r.out + r.err).not.toMatch(/dev_[0-9a-f]{8}/);

    expect(r.out).toContain([
      "Tools on this computer:",
      "  Claude Code  set up: every chat joins as its own session (opencadre-session server, session hooks, mail at turn end)",
      "  Codex        installed, pending hook trust: every chat joins as its own session after you trust OpenCadre in Codex Settings > Hooks (opencadre-session server, session hooks, idle wake, opencadre-inbox skill)",
      "  Cursor       set up: every chat joins as its own session (opencadre-session server, identity stamp, clearance gate, mail at turn end)",
    ].join("\n"));
    expect(r.out).toMatch(/Codex:.*same OpenCadre identity.*name and inbox/);
    expect(r.out).toMatch(/new identity does not inherit/);
    expect(r.out).not.toMatch(/after.*app restarts.*new name/i);
    expect(r.out).toContain("Cursor has no supported idle wake in this setup");
    // Cursor: the same keyless proxy, run as Cursor, and the hooks that name each chat and hold risky commands.
    expect(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [proxyPath, "--client", "cursor"] });
    const cursorHooks = readJson(path.join(home, ".cursor", "hooks.json"));
    expect(cursorHooks.version).toBe(1);
    const bin = path.join(home, ".opencadre", "bin");
    expect(cursorHooks.hooks.preToolUse).toEqual([{ command: `node "${path.join(bin, "opencadre-session-stamp.mjs")}" --client cursor`, timeout: 10, matcher: "^MCP:opencadre_" }]);
    expect(cursorHooks.hooks.beforeShellExecution).toEqual([{ command: `node "${path.join(bin, "opencadre-approval-gate.mjs")}" --client cursor`, timeout: 600, failClosed: true }]);
    expect(cursorHooks.hooks.stop).toEqual([{ command: `node "${path.join(bin, "opencadre-awareness.mjs")}" --client cursor`, timeout: 10, loop_limit: 1 }]);
    expect(readJson(path.join(home, ".claude.json")).theme).toBe("dark");
    const { devices } = await (await fetch(`${hub}/v1/org/devices`, { headers: { authorization: `Bearer ${operatorKey}` } })).json() as { devices: Array<{ deviceId: string; tools: string[]; client: string }> };
    expect(devices.find((d) => d.deviceId === deviceId)).toMatchObject({ client: "auto", tools: ["claude-code", "codex", "cursor"] });
  }, 60_000);

  it("keeps the global Cursor server when connect runs from the home folder", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const { code } = await newMachineCode("cursor");
    const r = await run(CLI, ["connect", "--hub", hub, "--code", code, "--client", "cursor"], { HOME: home, USERPROFILE: home }, home);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const config = readJson(path.join(home, ".cursor", "mcp.json"));
    const proxyPath = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
    expect(config.mcpServers["opencadre-session"]).toEqual({ type: "stdio", command: "node", args: [proxyPath, "--client", "cursor"] });
    expect(config.mcpServers["opencadre-project"]).toBeUndefined();
    expect(existsSync(path.join(home, ".cursor", "rules", "opencadre.mdc"))).toBe(false);
    expect(r.out).toContain("run connect from your project folder to add project tools");
  }, 60_000);

  it("migrates today's per-tool credential to the computer entry on the next connect", async () => {
    const home = tempHome();
    const credentialsFile = path.join(home, ".opencadre", "credentials.json");
    mkdirSync(path.dirname(credentialsFile), { recursive: true });
    const old = `dev_${"a".repeat(48)}`;
    writeFileSync(credentialsFile, JSON.stringify({ devices: { "claude-code": { hub: "http://old-hub", credential: old, deviceId: "old" }, reasonix: { note: "not ours" } } }));
    const { code, deviceId } = await newMachineCode("auto");
    const r = await connect(home, code, "--client", "claude-code");
    expect(r.code).toBe(0);
    const after = readJson(credentialsFile);
    expect(after.devices).toEqual({ reasonix: { note: "not ours" } });
    expect(after.computer).toMatchObject({ hub, deviceId });
    expect(JSON.stringify(after)).not.toContain(old);
    expect(r.out).toContain("This computer already had an OpenCadre credential; it was replaced.");
    expect(r.out + r.err).not.toContain(old);
  }, 60_000);

  it("--client narrows to one tool, and an older single-tool code sets up only its own tool", async () => {
    const both = () => {
      const home = tempHome();
      writeFileSync(path.join(home, ".claude.json"), "{}");
      mkdirSync(path.join(home, ".codex"));
      return home;
    };
    const narrowed = both();
    expect((await connect(narrowed, (await newMachineCode("auto")).code, "--client", "codex")).code).toBe(0);
    expect(existsSync(path.join(narrowed, ".codex", "config.toml"))).toBe(true);
    expect(readJson(path.join(narrowed, ".claude.json")).mcpServers).toBeUndefined();

    const older = both();
    const r = await connect(older, (await newMachineCode("claude-code")).code);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This code was made for Claude Code only, so only Claude Code was set up.");
    expect(existsSync(path.join(older, ".codex", "config.toml"))).toBe(false);
  }, 60_000);

  it("refuses tools it can't set up yet before the code is spent", async () => {
    const { code, deviceId } = await newMachineCode("auto");
    // Every tool connect can detect is set up on a connected computer now (Reasonix, the one still measured, is not
    // detected), so the refusal left is "nothing found", before the code is spent.
    expectOneActionableLine(await connect(tempHome(), code), 2, /No supported tool found/, /The code wasn't used/);
    expect(await machine(deviceId)).toMatchObject({ status: "waiting" });

    // Codex alone is enough.
    const codexOnly = tempHome();
    mkdirSync(path.join(codexOnly, ".codex"));
    expect((await connect(codexOnly, code)).code).toBe(0);
    expect(await machine(deviceId)).toMatchObject({ status: "connected" });
  }, 60_000);

  describe("on a computer that's already connected", () => {
    const credentialsOf = (home: string) => path.join(home, ".opencadre", "credentials.json");
    const backups = (home: string) => readdirSync(path.join(home, ".opencadre")).filter((f) => f.startsWith("credentials.json.bak-"));
    const devicesList = async () =>
      (await (await fetch(`${hub}/v1/org/devices`, { headers: { authorization: `Bearer ${operatorKey}` } })).json()).devices as Array<{ deviceId: string; name: string; status: string; tools: string[]; mergedIntoDeviceId: string | null }>;
    /** A home connected once with Claude Code only. */
    async function connectedHome() {
      const home = tempHome();
      writeFileSync(path.join(home, ".claude.json"), "{}");
      const first = await newMachineCode("auto");
      const r = await connect(home, first.code);
      expect(r.code, r.err).toBe(0);
      return { home, deviceId: first.deviceId, credential: readJson(credentialsOf(home)).computer.credential as string };
    }
    const nameOf = async (deviceId: string) => (await devicesList()).find((d) => d.deviceId === deviceId)!.name;

    it("a second connect updates the same computer: credentials.json stays byte-identical and Codex is added", async () => {
      const { home, deviceId, credential } = await connectedHome();
      const bytesBefore = readFileSync(credentialsOf(home));
      const backupsBefore = backups(home);
      expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
      mkdirSync(path.join(home, ".codex"));

      const second = await newMachineCode("auto");
      const r = await connect(home, second.code, "--verbose");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      // --verbose: the full report, file by file, and where it is saved.
      expect(r.out).toContain("\nFiles written:\n");
      expect(r.out.trimEnd().split("\n").pop()).toBe(`This report is also saved in ${path.join(home, ".opencadre", "last-connect.txt")}.`);

      expect(readFileSync(credentialsOf(home)).equals(bytesBefore)).toBe(true);
      expect(backups(home)).toEqual(backupsBefore);
      const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      expectSaneToml(toml);
      expect(toml).toContain("[mcp_servers.opencadre-session]");
      expect(toml).not.toContain("dev_");

      const name = await nameOf(deviceId);
      expect(r.out).toContain(`Updated this computer, ${name}: set up Claude Code and Codex. Chats in enabled projects join automatically.`);
      expect(r.out).not.toContain("Connected this computer to");
      expect(r.out).not.toContain("it was replaced");
      expect(r.out).toContain("credentials.json (this computer's credential, unchanged)");
      expect(r.out + r.err).not.toContain(credential);
      expect(r.out + r.err).not.toMatch(/dev_[0-9a-f]{8}/);

      const devices = await devicesList();
      expect(devices.find((d) => d.deviceId === second.deviceId)).toMatchObject({ status: "merged", mergedIntoDeviceId: deviceId });
      expect(devices.find((d) => d.deviceId === deviceId)).toMatchObject({ status: "connected", tools: ["claude-code", "codex"] });
      // The credential is still in exactly one file.
      expect(allFiles(home).filter((f) => readFileSync(f, "utf8").includes(credential))).toEqual([credentialsOf(home)]);
    }, 90_000);

    it("today's per-tool credentials.json (the operator's laptop) merges too, moving the same credential to the computer entry", async () => {
      const home = tempHome();
      writeFileSync(path.join(home, ".claude.json"), "{}");
      mkdirSync(path.join(home, ".codex"));
      const old = await newMachineCode("claude-code");
      const redeemed = await (await fetch(`${hub}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: old.code }) })).json();
      const credential = redeemed.deviceCredential as string;
      mkdirSync(path.join(home, ".opencadre"));
      writeFileSync(credentialsOf(home), JSON.stringify({ devices: { "claude-code": { hub, credential, deviceId: old.deviceId } }, note: "kept" }));

      const second = await newMachineCode("auto");
      const r = await connect(home, second.code);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const after = readJson(credentialsOf(home));
      expect(after).toEqual({ note: "kept", computer: { hub, credential, deviceId: old.deviceId } });
      expect(r.out).toContain(`Updated this computer, ${await nameOf(old.deviceId)}: set up Claude Code and Codex.`);
      expect(r.out).not.toContain("it was replaced");
      expect(r.out + r.err).not.toContain(credential);
      // The older one-tool computer now labels each session by its own tool.
      expect(db.prepare(`SELECT client FROM devices WHERE id = ?`).get(old.deviceId)).toEqual({ client: "auto" });
      expect((await devicesList()).find((d) => d.deviceId === second.deviceId)).toMatchObject({ status: "merged", mergedIntoDeviceId: old.deviceId });
    }, 90_000);

    it("a stored credential the hub no longer accepts gets a new computer, and the new credential is written", async () => {
      const { home, deviceId, credential } = await connectedHome();
      await fetch(`${hub}/v1/org/devices/${deviceId}`, { method: "DELETE", headers: { authorization: `Bearer ${operatorKey}` } });
      const second = await newMachineCode("auto");
      const r = await connect(home, second.code);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const { computer } = readJson(credentialsOf(home));
      expect(computer).toMatchObject({ hub, deviceId: second.deviceId });
      expect(computer.credential).toMatch(/^dev_[0-9a-f]{48}$/);
      expect(computer.credential).not.toBe(credential);
      expect(r.out).toContain("Connected this computer to");
      expect(r.out).toContain("This computer already had an OpenCadre credential; it was replaced.");
      expect(r.out + r.err).not.toMatch(/dev_[0-9a-f]{8}/);
      expect((await devicesList()).find((d) => d.deviceId === second.deviceId)).toMatchObject({ status: "connected", mergedIntoDeviceId: null });
    }, 90_000);

    it("connect with no code re-runs setup with the stored credential and reports the tools", async () => {
      const { home, deviceId, credential } = await connectedHome();
      const bytesBefore = readFileSync(credentialsOf(home));
      const computersBefore = (await devicesList()).length;
      mkdirSync(path.join(home, ".codex"));
      // No --hub either: the stored credential names its hub.
      const r = await run(CLI, ["connect", "--home", home]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Re-ran setup for ${await nameOf(deviceId)}: set up Claude Code and Codex. Chats in enabled projects join automatically.`);
      expect(readFileSync(credentialsOf(home)).equals(bytesBefore)).toBe(true);
      expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.opencadre-session]");
      expect((await devicesList()).find((d) => d.deviceId === deviceId)).toMatchObject({ tools: ["claude-code", "codex"] });
      expect((await devicesList()).length).toBe(computersBefore);
      expect(r.out + r.err).not.toContain(credential);
      expect(r.out + r.err).not.toMatch(/dev_[0-9a-f]{8}/);

      const dry = await run(CLI, ["connect", "--home", home, "--dry-run"]);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain("Dry run: nothing was checked or written.");
      expect(dry.out + dry.err).not.toContain(credential);
    }, 90_000);

    it("connect with no code on a computer that isn't connected, or whose credential was removed, says so and writes nothing", async () => {
      const fresh = tempHome();
      writeFileSync(path.join(fresh, ".claude.json"), "{}");
      expectOneActionableLine(await run(CLI, ["connect", "--home", fresh]), 1, /^opencadre: This computer isn't connected\. Add it in the console\.$/);
      expect(readFileSync(path.join(fresh, ".claude.json"), "utf8")).toBe("{}");

      const { home, deviceId, credential } = await connectedHome();
      await fetch(`${hub}/v1/org/devices/${deviceId}`, { method: "DELETE", headers: { authorization: `Bearer ${operatorKey}` } });
      mkdirSync(path.join(home, ".codex"));
      const bytesBefore = readFileSync(credentialsOf(home));
      const r = await run(CLI, ["connect", "--home", home]);
      expectOneActionableLine(r, 1, /^opencadre: This computer isn't connected\. Add it in the console\.$/);
      expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
      expect(readFileSync(credentialsOf(home)).equals(bytesBefore)).toBe(true);
      expect(r.out + r.err).not.toContain(credential);

      // A --hub the stored credential isn't for counts as not connected there.
      const { home: other } = await connectedHome();
      expectOneActionableLine(await run(CLI, ["connect", "--home", other, "--hub", "http://127.0.0.1:9"]), 1, /This computer isn't connected/);
    }, 90_000);
  });

  it("the code is spent once", async () => {
    const { code } = await newMachineCode();
    expect((await connect(tempHome(), code, "--client", "claude-code")).code).toBe(0);
    const again = await connect(tempHome(), code, "--client", "claude-code");
    expectOneActionableLine(again, 1, /already used/);
  }, 60_000);

  it("refuses to spend the code when a file it merges is unreadable", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".opencadre"));
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), "{ not json");
    const { code, deviceId } = await newMachineCode();
    const r = await connect(home, code, "--client", "claude-code");
    expect(r.code).toBe(1);
    expect(r.err).toContain("credentials.json");
    expect(await machine(deviceId)).toMatchObject({ status: "waiting" });
  }, 30_000);
});

/** A stand-in hub that answers every request with a fixed status and JSON body per path. */
async function fakeHub(routes: Record<string, [number, unknown]>) {
  const fake = http.createServer((req, res) => {
    const [status, body] = routes[(req.url ?? "").split("?")[0]] ?? [404, { error: "not found" }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fake.listen(0, resolve));
  const addr = fake.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, close: () => fake.close() };
}

/** R5: every way connect can fail ends in one line that says what happened and what to do next. */
function expectOneActionableLine(r: { code: number | null; err: string }, exitCode: number, ...patterns: RegExp[]) {
  expect(r.code).toBe(exitCode);
  const lines = r.err.trim().split(/\r?\n/).filter((l) => !l.startsWith("usage:") && !l.startsWith("       opencadre"));
  expect(lines, r.err).toHaveLength(1);
  expect(lines[0]).toMatch(/^opencadre: /);
  expect(r.err).not.toMatch(/\n\s+at /);
  for (const pattern of patterns) expect(lines[0]).toMatch(pattern);
}

// Each test here starts the CLI as a child process.
describe("opencadre connect: failure states say what to do next", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("a mistyped code", async () => {
    expectOneActionableLine(await connect(tempHome(), "oc_short"), 2, /--code must look like/, /copy the command from the console again/);
  });

  it("an unknown client", async () => {
    const r = await connect(tempHome(), "oc_ZZZZZZZZZZ", "--client", "not-a-client");
    expectOneActionableLine(r, 2, /"not-a-client" isn't a supported client/, /claude-code, codex, cursor, antigravity, gemini, grok/);
  });

  // dsh is a DEVICE client (COMPUTER_TOOLS) but is absent from cli/lib/clients.mjs's CLIENTS
  // and from its detection `present` map. Two lies follow from that one omission, and this test
  // pins the user-visible one so it cannot come back:
  //
  // the generic client guard runs BEFORE the device guard, so a coded connect with --client dsh
  // is refused with "isn't a supported client" naming the CLIENTS list -- which does NOT contain
  // dsh. So the message tells the user dsh is unsupported while DEVICE_CLIENTS advertises it as
  // one of the three tools a computer credential serves. Measured on 2026-09-18 at main 296772c.
  //
  // The refusal must name DeepSeek Harness and give the real reason (it can't be detected yet),
  // not misreport it as an unknown client.
  it("dsh is refused as an undetectable device client, not as an unknown client", async () => {
    expectOneActionableLine(await connect(tempHome(), "ocd_ZZZZZZZZZZ", "--client", "dsh"), 2, /DeepSeek Harness/, /not yet detected|can't be detected|cannot be detected/);
  });

  it("the supported-client list never names a client this command cannot detect", async () => {
    // The list in this message is generated from CLIENTS, so it is the honest inventory of what
    // connect can find. dsh must not appear in it until detection can actually find dsh -- that
    // pairing is the whole point of the fix.
    const r = await connect(tempHome(), "oc_ZZZZZZZZZZ", "--client", "not-a-client");
    expect(r.err).not.toMatch(/auto, [^\n]*dsh/);
  });

  // grok is in the client table (recognized, being measured) but has no config writer, so
  // planClientConfig used to match nothing and throw "Cannot read properties of undefined
  // (reading 'path')" -- a raw TypeError on the ONE line, which expectOneActionableLine's
  // no-stack-trace assertion catches. Note this must NOT refuse cursor/gemini/antigravity:
  // those are measuring too, but each has a writer, so they are genuinely connectable.
  it("a client with no config writer is refused in words, not as a crash", async () => {
    expectOneActionableLine(
      await connect(tempHome(), "oc_ZZZZZZZZZZ", "--client", "grok"),
      2,
      /Grok Build isn't supported yet/,
      /The code wasn't used/,
      /connect it with one of Claude Code, Codex, Cursor, Antigravity, Gemini CLI/,
    );
  });

  it("no supported client on this machine", async () => {
    expectOneActionableLine(await connect(tempHome(), "oc_ZZZZZZZZZZ"), 2, /No supported client found/, /Re-run with --client/);
  });

  it("does not infer an installed Cursor from OpenCadre-created config alone", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "opencadre-session": { command: "node" } } }));
    expectOneActionableLine(await connect(home, "oc_ZZZZZZZZZZ"), 2, /No supported client found/, /Re-run with --client/);
  });

  // The trap this closes: with a .grok folder present, detection found grok and the CLI told the
  // user to re-run with "--client claude-code|codex|grok" -- and then REFUSED grok, because it has
  // no writer. The prompt must never name a client the same command will turn down, so detection is
  // split: servable clients are offered, unservable ones are reported as found-but-not-offered.
  it("never offers a client it would then refuse", async () => {
    // Two SERVABLE clients have to be present for the "pick one" prompt to be reached at all --
    // with one, the CLI just uses it. .codex gives a writer, .cursor a second; .grok has no writer
    // and must appear only in the "found but not offered" clause, never in the re-run list.
    const { code } = await newCode();
    const home = tempHome();
    for (const d of [".grok", ".codex", ".cursor"]) mkdirSync(path.join(home, d), { recursive: true });
    markCursorInstalled(home);
    const r = await connect(home, code);
    expect(r.err).toContain("re-run with --client codex|cursor");
    expect(r.err).not.toMatch(/--client[^\n]*grok/);
    expect(r.err).toContain("Grok Build was also found but cannot be set up yet");
  });

  // One servable client plus one unservable: the CLI sets up the servable one and says what it
  // left behind, rather than silently ignoring the .grok folder the user can see.
  it("names an unservable client it found but did not set up", async () => {
    const { code } = await newCode();
    const home = tempHome();
    for (const d of [".grok", ".codex"]) mkdirSync(path.join(home, d), { recursive: true });
    const r = await connect(home, code);
    expect(r.out).toContain("Grok Build was also found but cannot be set up yet");
  });

  // grok alone: nothing servable was found, and the refusal must say so rather than staying silent
  // about the client the user can see in their home directory.
  it("a machine with only an unservable client says which one and why", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".grok"), { recursive: true });
    expectOneActionableLine(await connect(home, "oc_ZZZZZZZZZZ"), 2, /No supported client found/, /Grok Build was also found but cannot be set up yet/);
  });

  it("an expired code, which stays unusable", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code } = await newCode();
    db.prepare(`UPDATE connect_codes SET expires_at = ? WHERE code_hash = ?`).run(new Date(Date.now() - 1000).toISOString(), hashKey(code));
    expectOneActionableLine(await connect(home, code), 1, /expired/, /generate a new command in the console/i);
    expect(existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(false);
  }, 30_000);

  it("an agent name taken since the code was made", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code, agentName } = await newCode();
    registerAgent(cliOrgId, agentName);
    expectOneActionableLine(await connect(home, code), 1, /different name/);
    expect(existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(false);
  }, 30_000);

  it("a hub that can't be reached", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const r = await run(CLI, ["connect", "--hub", "http://127.0.0.1:9", "--code", "oc_ZZZZZZZZZZ", "--home", home]);
    expectOneActionableLine(r, 1, /Could not reach http:\/\/127\.0\.0\.1:9/, /code wasn't used/, /run the same command again/);
  }, 30_000);

  it("a hub that stops answering, where the code may already be spent", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const silent = http.createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => silent.listen(0, resolve));
    const addr = silent.address();
    try {
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const r = await run(CLI, ["connect", "--hub", url, "--code", "oc_ZZZZZZZZZZ", "--home", home], { OPENCADRE_CONNECT_TIMEOUT_MS: "500" });
      expectOneActionableLine(r, 1, /didn't answer within 0\.5 s, so the code may have been used/, /if it says the code was already used, generate a new command/);
      expect(r.err).not.toContain("wasn't used");
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  }, 30_000);

  it("too many attempts, and a hub error", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    for (const [status, error, pattern] of [
      [429, "nope", /Wait a minute/],
      [503, "nope", /hub hit an error \(HTTP 503\).*run the same command again/],
      [423, "this workspace is paused by an operator; ask them to resume it, then run the same command again", /paused by an operator; ask them to resume it.*The code wasn't used/],
    ] as const) {
      const fake = await fakeHub({ "/v1/connect/redeem": [status, { error }] });
      try {
        const r = await run(CLI, ["connect", "--hub", fake.url, "--code", "oc_ZZZZZZZZZZ", "--home", home]);
        expectOneActionableLine(r, 1, pattern);
      } finally {
        fake.close();
      }
    }
  }, 30_000);

  it("a key the hub refuses because the workspace is paused", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const fake = await fakeHub({
      "/v1/connect/redeem": [201, { apiKey: `agt_${"a".repeat(48)}`, agentName: "Paused-Agent", agentId: "x", client: "cursor", orgName: "Paused Org" }],
      "/v1/me": [423, { error: "This workspace is paused by an operator. Nothing runs until an operator resumes it." }],
    });
    try {
      const r = await run(CLI, ["connect", "--hub", fake.url, "--code", "oc_ZZZZZZZZZZ", "--home", home]);
      expectOneActionableLine(r, 1, /this workspace is paused by an operator/, /Ask an operator to resume it/, /nothing needs reconnecting/);
      expect(r.err).not.toContain("agt_");
    } finally {
      fake.close();
    }
  }, 30_000);
});

describe("opencadre connect: safety", () => {
  it("refuses to guess between several detected clients without a TTY, and leaves the code unspent", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code } = await newCode();
    const r = await connect(home, code);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--client");
    expect(r.err).toContain("codex");
    expect(r.err).toContain("cursor");
    expect((await status(code)).state).toBe("pending");
  }, 30_000);

  it("surfaces redeem errors as one clean line", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const unknown = await connect(home, "oc_ZZZZZZZZZZ");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/isn't valid/);
    expect(unknown.err).not.toMatch(/\n\s+at /);

    const { code } = await newCode();
    expect((await connect(home, code)).code).toBe(0);
    const used = await connect(tempHome(), code, "--client", "cursor");
    expect(used.code).toBe(1);
    expect(used.err).toMatch(/already used/);
  }, 30_000);

  it("refuses to spend the code when the target config is unreadable", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ not json");
    const { code } = await newCode();
    const r = await connect(home, code);
    expect(r.code).toBe(1);
    expect(r.err).toContain("mcp.json");
    expect((await status(code)).state).toBe("pending");
  }, 30_000);

  it("--dry-run prints the plan, writes nothing and does not redeem", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code } = await newCode();
    const r = await connect(home, code, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain(path.join(home, ".cursor", "mcp.json"));
    expect(readdirSync(path.join(home, ".cursor"))).toEqual(["cli-config.json"]);
    expect(existsSync(path.join(home, ".opencadre"))).toBe(false);
    expect((await status(code)).state).toBe("pending");
  }, 30_000);

  it("smoke-tests the new key and sets a status so the console flips to Online", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code, agentName } = await newCode();
    expect((await connect(home, code)).code).toBe(0);
    // Only the CLI has checked in: the client itself still has to start, so the stage says "installed", not online.
    expect(await status(code)).toMatchObject({ state: "redeemed", stage: "installed", agentOnline: true, agentName });
    const { agents } = await (await fetch(`${hub}/v1/agents`, { headers: { authorization: `Bearer ${operatorKey}` } })).json();
    expect(agents.find((a: { name: string }) => a.name === agentName)?.current_task).toBe("Connected via opencadre connect");
  }, 30_000);

  it("installs helpers whose imports resolve from ~/.opencadre/bin", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".cursor"));
    markCursorInstalled(home);
    const { code } = await newCode();
    expect((await connect(home, code)).code).toBe(0);
    const bin = path.join(home, ".opencadre", "bin");
    // The dot-prefixed manifest is metadata about the install, not one of the helpers: it records
    // the stamp and per-file hashes so a machine can say which revision it is running. Listed here
    // explicitly so a NEW file appearing in this directory is always a deliberate change to this
    // assertion, never a silent addition.
    // Since Q1g PR-2: the entry paths clients reference are stable stubs, and the helpers themselves live in ONE
    // generation folder (.gen/<id>/) the stubs load through .gen/current (cli/lib/generations.mjs).
    expect(readdirSync(bin).sort()).toEqual([".gen", ".opencadre-install.json", "opencadre-amp-plugin.mjs", "opencadre-antigravity.mjs", "opencadre-approval-gate-loader.mjs", "opencadre-approval-gate.mjs", "opencadre-awareness.mjs", "opencadre-cline-hook.mjs", "opencadre-kilo-plugin.js", "opencadre-mcp.mjs", "opencadre-session-stamp.mjs", "opencadre-usage.mjs", "opencadre-wake.mjs", "opencode-plugin"]);
    // OpenCode's plugin is a FOLDER, which OpenCode loads from `plugins`: its entry stub, and its logic in the generation.
    expect(readdirSync(path.join(bin, "opencode-plugin")).sort()).toEqual(["index.js"]);
    const gen = path.join(bin, ".gen", readFileSync(path.join(bin, ".gen", "current"), "utf8").trim());
    expect(readdirSync(path.join(gen, "opencode-plugin")).sort()).toEqual(["clearance.js", "index.js", "mail.js"]);
    expect(readFileSync(path.join(gen, "opencadre-awareness.mjs"), "utf8")).not.toContain("../../");
    // The Codex identity stamp imports the signer from opencadre-config.mjs, so it must find it as a sibling too.
    expect(readFileSync(path.join(gen, "opencadre-session-stamp.mjs"), "utf8")).not.toContain("../../");
    expect(readFileSync(path.join(gen, "opencadre-session-stamp.mjs"), "utf8")).toContain('from "./opencadre-config.mjs"');
    expect(readFileSync(path.join(gen, "opencadre-approval-gate.mjs"), "utf8")).not.toContain("../../");
    // The client table ships beside the readers, so opencadre-config.mjs finds it as a sibling after install.
    expect(readFileSync(path.join(gen, "opencadre-config.mjs"), "utf8")).not.toContain("../../");
    expect(readFileSync(path.join(gen, "opencadre-config.mjs"), "utf8")).toContain('from "./opencadre-clients.mjs"');
    // Async spawns, like everywhere else in this file: this process hosts the hub, and seconds of sync spawns on a busy
    // machine outlast the hub's 5 s keep-alive, which then resets the pooled connection the next test's fetch reuses.
    // The gate imports the secret-masking helper next to it: a command matching no rule passes silently once both load.
    const gateHome = tempHome();
    const gate = await run(path.join(bin, "opencadre-approval-gate.mjs"), [], { HOME: gateHome, USERPROFILE: gateHome, OPENCADRE_HOOK_HOME: gateHome }, undefined,
      JSON.stringify({ tool_input: { command: "ls" }, cwd: gateHome }));
    expect(gate.code).toBe(0);
    expect(gate.err).toBe("");
    // The hook exits silently with no hub configured; the wake script reports missing config. Both prove their imports load.
    const hook = await run(path.join(bin, "opencadre-awareness.mjs"), [], { OPENCADRE_HOOK_HOME: tempHome() }, undefined, "{}");
    expect(hook.code).toBe(0);
    expect(hook.err).toBe("");
    const wake = await run(path.join(bin, "opencadre-wake.mjs"), [], { OPENCADRE_HOOK_HOME: tempHome() });
    expect(wake.out).toContain("OPENCADRE WAKE ERROR");
    // The stamp, run FROM THE INSTALL FOLDER on an OpenCadre call: exit 0 with an empty stderr proves its import of the
    // signer loaded there (a missing sibling throws). This install is a named-agent one with no DEVICE credential, so
    // the stamp has nothing to sign with and must say nothing: signing itself is proven in codex-session-stamp.test.ts.
    const stamp = await run(path.join(bin, "opencadre-session-stamp.mjs"), [], { HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home }, undefined,
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "chat-1", tool_name: "mcp__opencadre_session__set_status", tool_input: { task: "t" } }));
    expect(stamp.code).toBe(0);
    expect(stamp.err).toBe("");
    expect(stamp.out).toBe("");
  }, 30_000);
});

/** Minimal ustar reader: 512-byte headers, name at 0..100, octal size at 124..136. */
function untar(tgz: Buffer, dest: string) {
  const tar = gunzipSync(tgz);
  const names: string[] = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const file = path.join(dest, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, tar.subarray(off + 512, off + 512 + size));
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("GET /cli/opencadre-cli.tgz", () => {
  it("is 503 until the package is built, then serves a tarball whose CLI connects on its own", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "oc-cli-pack-"));
    process.env.OPENCADRE_CLI_TARBALL = path.join(out, "opencadre-cli.tgz");
    try {
      const missing = await fetch(`${hub}/cli/opencadre-cli.tgz`);
      expect(missing.status).toBe(503);
      expect((await missing.json()).error).toMatch(/npm run build/);

      const packed = await run(path.join(process.cwd(), "scripts", "pack-cli.mjs"), ["--out", out], { PATH: process.env.PATH ?? process.env.Path ?? "" });
      expect(packed.err).not.toMatch(/error/i);
      expect(packed.code).toBe(0);

      const res = await fetch(`${hub}/cli/opencadre-cli.tgz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");

      const extracted = mkdtempSync(path.join(tmpdir(), "oc-cli-extract-"));
      const names = untar(Buffer.from(await res.arrayBuffer()), extracted);
      for (const f of ["package/package.json", "package/bin/opencadre.mjs", "package/helpers/opencadre-awareness.mjs", "package/helpers/opencadre-wake.mjs", "package/helpers/pure-ack.mjs", "package/templates/codex-inbox-skill.md", "package/templates/codex-inbox-setup.txt"]) {
        expect(names).toContain(f);
      }
      expect(readJson(path.join(extracted, "package", "package.json")).bin).toEqual({ opencadre: "bin/opencadre.mjs" });

      const home = tempHome();
      mkdirSync(path.join(home, ".cursor"));
      markCursorInstalled(home);
      const { code } = await newCode();
      const r = await run(path.join(extracted, "package", "bin", "opencadre.mjs"), ["connect", "--hub", hub, "--code", code, "--home", home]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(readdirSync(path.join(home, ".opencadre", "bin"))).toContain("opencadre-awareness.mjs");
    } finally {
      delete process.env.OPENCADRE_CLI_TARBALL;
    }
  }, 120_000);
});

// Found in a timed run: an agent ran connect on a PC whose Claude Code already had a user-wide OpenCadre agent, and
// connect replaced it silently. Every open session's hooks started acting as the new agent at once.
describe("opencadre connect: never replaces an existing agent silently", () => {
  it("Claude Code without a terminal connects the new agent for the current folder only, and says so", async () => {
    const home = tempHome();
    const folder = mkdtempSync(path.join(tmpdir(), "oc-cli-folder-"));
    const first = await newCode();
    expect((await connect(home, first.code, "--client", "claude-code")).code).toBe(0);
    const configFile = path.join(home, ".claude.json");
    const firstKey = keyIn(readJson(configFile).mcpServers.opencadre.headers.Authorization);

    const second = await newCode();
    const r = await run(CLI, ["connect", "--hub", hub, "--code", second.code, "--home", home, "--client", "claude-code"], {}, folder);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`already runs agent "${first.agentName}"`);
    expect(r.out).toContain("--replace");
    const config = readJson(configFile);
    expect(keyIn(config.mcpServers.opencadre.headers.Authorization)).toBe(firstKey);
    const projectEntries = Object.values(config.projects ?? {}) as Array<{ mcpServers?: { opencadre?: { headers: { Authorization: string } } } }>;
    const secondKey = keyIn(projectEntries.find((p) => p.mcpServers?.opencadre)?.mcpServers?.opencadre?.headers.Authorization ?? "");
    expect(secondKey).not.toBe("");
    expect(secondKey).not.toBe(firstKey);
    expect(r.out).not.toContain(firstKey);
    expect(r.out).not.toContain(secondKey);
  }, 60_000);

  it("Codex (one agent per user) refuses before spending the code; --replace switches it", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const first = await newCode("codex");
    expect((await connect(home, first.code, "--client", "codex")).code).toBe(0);
    const configFile = path.join(home, ".codex", "config.toml");
    const before = readFileSync(configFile, "utf8");

    const second = await newCode("codex");
    const refused = await connect(home, second.code, "--client", "codex");
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(`already runs agent "${first.agentName}"`);
    expect(refused.err).toContain("The code wasn't used");
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect((await status(second.code)).state).toBe("pending");

    const replaced = await connect(home, second.code, "--client", "codex", "--replace");
    expect(replaced.code).toBe(0);
    expect(keyIn(readFileSync(configFile, "utf8"))).not.toBe(keyIn(before));
  }, 60_000);

  it("replaces an entry whose key the hub no longer accepts, with a note", async () => {
    const home = tempHome();
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { opencadre: { type: "http", url: `${hub}/mcp`, headers: { Authorization: `Bearer agt_${"0".repeat(48)}` } } } }));
    const { code } = await newCode();
    const r = await connect(home, code, "--client", "claude-code");
    expect(r.code).toBe(0);
    expect(r.out).toContain("no longer accepts");
    expect(keyIn(readJson(path.join(home, ".claude.json")).mcpServers.opencadre.headers.Authorization)).not.toBe("0".repeat(48));
  }, 60_000);

  it("asks agents to show the next steps to the user word for word", async () => {
    const home = tempHome();
    const { code } = await newCode();
    const r = await connect(home, code, "--client", "claude-code");
    expect(r.out).toContain("show these to the user word for word");
  }, 60_000);
});
