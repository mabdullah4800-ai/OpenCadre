// PR-E1, addendum §3.3: the identity proxy and the awareness hook load the update-notice module LAZILY, so a failure in
// that advisory module can never cost a chat its identity.
//
// CALIBRATED, in an isolated home with a real hub and a real installed generation (connect run by this checkout's CLI):
//   1. KNOWN POSITIVE. The code as it was at BASE (origin/main when this branch was cut; its opencadre-mcp.mjs and
//      opencadre-awareness.mjs are read from git into the isolated generation, never from the live tree) with a notice
//      module that throws at evaluation: the proxy FAILS initialize and the hook emits NO identity. A control of that
//      control (BASE code, intact module) passes, and the failure names the injected error, so the red is the defect and
//      not drift in BASE's other imports.
//   2. THE FIX. The same corruption against this head: initialize succeeds, a STAMPED tools/call resolves the chat's
//      identity, SessionStart carries the identity text, no build report is sent, and stderr has one line about it.
//      Also for a MISSING module and for a module whose function throws (method failure).
//   3. NO REGRESSION. With an intact module the build report is sent exactly once per proxy (as at BASE), and the hook's
//      notice text is byte-identical to BASE's hook running the same module.
//   4. PINNING. The module resolves inside the proxy's OWN generation even when the pointer moves before it loads.
//
// Set E1_CALIBRATION_RECEIPTS=<folder> to keep each run's raw outputs (stdout, stderr, exit) as JSON receipts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { waitFor } from "./helpers/spawn.js";
import { computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode } from "./helpers/device-hub.js";
import { installTransform } from "../cli/lib/helpers.mjs";

/** origin/main when this branch was cut: the code before the fix. */
const BASE = "3e5c23df6d7bde06168da883e9847885523e00b2";
const MARK = "E1-CALIBRATION";
const CLIENT = "cursor";
const CHAT = "lazy-import-chat";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const receiptsDir = process.env.E1_CALIBRATION_RECEIPTS;
const receipt = (name: string, data: unknown) => {
  if (!receiptsDir) return;
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(path.join(receiptsDir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
};

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
let hub: { url: string; close: () => Promise<void> };
let buildReports = 0;
let home: string;
let bin: string;
let project: string;
let env: Record<string, string>;
let deviceId: string;
let operatorKey: string;
let baseGen: string;
let baseMeta: { helpers: Record<string, string> } & Record<string, unknown>;
const atBase = (repoPath: string) => installTransform(execFileSync("git", ["show", `${BASE}:${repoPath}`], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

beforeAll(async () => {
  // The real hub, counting the proxy's build reports on the way in.
  const { app } = await import("../src/rest.js");
  const { handleMcpRequest } = await import("../src/mcp.js");
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/devices/connector-build" && req.method === "POST") buildReports++;
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  const fleet = await operatorWorkspace("Lazy import calibration");
  operatorKey = fleet.operatorKey;
  project = gitProject("LazyImport");
  await enableProject(hub.url, operatorKey, "local:LazyImport");
  home = tmpDir("oc-lazy-home-");
  bin = path.join(home, ".opencadre", "bin");
  env = { ...isolatedCliEnv(home), OPENCADRE_HOOK_HOME: home, CLAUDE_CODE_SESSION_ID: CHAT, CODEX_THREAD_ID: CHAT };
  const minted = await mintDevice(hub.url, operatorKey, CLIENT);
  deviceId = minted.deviceId;
  const connected = await runNode(path.join(process.cwd(), "cli", "bin", "opencadre.mjs"), ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", CLIENT], env, project);
  if (connected.code !== 0) throw new Error(`connect failed: ${connected.err}`);
  baseGen = readFileSync(path.join(bin, ".gen", "current"), "utf8").trim();
  baseMeta = JSON.parse(readFileSync(path.join(bin, ".gen", baseGen, ".generation.json"), "utf8"));
  // The fixture premise: this checkout's generation imports the notice lazily, BASE's statically.
  const fixed = readFileSync(path.join(bin, ".gen", baseGen, "opencadre-mcp.mjs"), "utf8");
  if (/^import .*opencadre-update-notice\.mjs/m.test(fixed) || !fixed.includes('import("./opencadre-update-notice.mjs")')) throw new Error("premise: the installed proxy should import the notice lazily");
  if (!/^import \{ reportConnectorBuild \} from "\.\/opencadre-update-notice\.mjs";/m.test(atBase("scripts/opencadre-mcp.mjs"))) throw new Error("premise: BASE's proxy should import the notice statically");
}, 120_000);
afterAll(async () => { if (hub) await hub.close(); });

type Swap = Record<string, string | null>;
/** A new generation: a copy of the installed one with `swap` applied (text, or null to delete), its .generation.json
 * updated so the tree still verifies, and the pointer switched to it. Returns its folder. */
function generation(swap: Swap): string {
  const id = randomBytes(6).toString("hex");
  const dir = path.join(bin, ".gen", id);
  cpSync(path.join(bin, ".gen", baseGen), dir, { recursive: true });
  const helpers = { ...baseMeta.helpers };
  for (const [name, text] of Object.entries(swap)) {
    if (text === null) {
      rmSync(path.join(dir, name));
      delete helpers[name];
    } else {
      writeFileSync(path.join(dir, name), text);
      helpers[name] = sha(text);
    }
  }
  writeFileSync(path.join(dir, ".generation.json"), JSON.stringify({ ...baseMeta, id, helpers }));
  writeFileSync(path.join(bin, ".gen", "current"), `${id}\n`);
  return dir;
}
const installed = (name: string) => readFileSync(path.join(bin, ".gen", baseGen, name), "utf8");
const throwing = () => `${installed("opencadre-update-notice.mjs")}\nthrow new Error("${MARK}: the notice module failed to evaluate");\n`;
const methodThrows = () => installed("opencadre-update-notice.mjs")
  .replace("export async function connectorUpdateNotice(", `export function connectorUpdateNotice() { throw new Error("${MARK}: notice method"); }\nasync function unusedNotice(`)
  .replace("export async function reportConnectorBuild(", `export function reportConnectorBuild() { throw new Error("${MARK}: report method"); }\nasync function unusedReport(`);

type ProxyRun = { initialized: boolean; exitCode: number | null; identity: string | null; err: string; reports: number };
/** Starts the proxy through the stable root stub, as Cursor does; initialize; then one STAMPED tools/call. */
async function runProxy(label: string, stateDir: string): Promise<ProxyRun> {
  const before = buildReports;
  const proxy = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), { ...env, OPENCADRE_AWARENESS_STATE_DIR: stateDir }, project, CLIENT);
  const outcome = await Promise.race([
    proxy.initialize().then((m) => ({ ok: !m.error })),
    proxy.exited.then((code) => ({ ok: false, code })),
  ]).catch(() => ({ ok: false }));
  const run: ProxyRun = { initialized: outcome.ok, exitCode: null, identity: null, err: "", reports: 0 };
  if (outcome.ok) {
    // The generation's own signer, so the stamp is the one this install's hook would mint.
    const gen = readFileSync(path.join(bin, ".gen", "current"), "utf8").trim();
    const config = await import(/* @vite-ignore */ `${pathToFileURL(path.join(bin, ".gen", gen, "opencadre-config.mjs")).href}?v=${gen}`);
    const credential = computerCredential(home);
    const stamp = config.mintStamp(credential, config.scopedSessionId(CLIENT, CHAT, env));
    const tools = (await proxy.request("tools/list")).result?.tools as { name: string }[] | undefined;
    const name = tools?.find((t) => /get_active_agents$/.test(t.name))?.name ?? "opencadre_get_active_agents";
    try {
      run.identity = await proxy.callTool(name, { _opencadre_stamp: stamp });
    } catch (err) {
      run.identity = null;
      run.err += String(err);
    }
    // The report is fire-and-forget: give it time to arrive (a negative case simply waits this out).
    await waitFor(() => buildReports > before, "a build report", 3000).catch(() => {});
    await proxy.close();
  }
  run.exitCode = await proxy.exited;
  run.err += proxy.err;
  run.reports = buildReports - before;
  // The credential must never appear in what the proxy printed.
  if ((proxy.out + proxy.err).includes(computerCredential(home))) throw new Error("credential printed");
  receipt(`proxy-${label}`, { ...run, stdout: proxy.out });
  return run;
}

/** Runs the awareness hook through its stable root stub with a fake hub (identity + digest + manifest). */
function runHook(label: string, fake: string, stateDir: string): Promise<{ code: number | null; out: string; err: string; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(bin, "opencadre-awareness.mjs"), "--client", "claude-code"], {
      env: { ...env, OPENCADRE_URL: fake, OPENCADRE_KEY: "fixture-not-a-key", OPENCADRE_AWARENESS_STATE_DIR: stateDir }, windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: `hook-${label}`, cwd: project }));
    child.on("close", (code) => {
      let text = "";
      try { text = JSON.parse(out).hookSpecificOutput.additionalContext; } catch { /* silence */ }
      receipt(`hook-${label}`, { code, stdout: out, stderr: err });
      resolve({ code, out, err, text });
    });
  });
}

/** A stand-in hub for the hook: a named agent's identity, no goal or digest, and a manifest whose helpers differ. */
let fake: http.Server;
let fakeUrl: string;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const stamp = "abcdef012345";
    if (req.url === "/cli/manifest.json") return res.end(JSON.stringify({ tarball: { stamp, sha256: stamp + "a".repeat(52), bytes: 4096, url: `${fakeUrl}/cli/${stamp}/opencadre-cli.tgz` }, command: `npx -y ${fakeUrl}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`, helpers: { "opencadre-awareness.mjs": "f".repeat(64) } }));
    if (req.url === "/v1/me") return res.end(JSON.stringify({ agentName: "Lazy-Fixture", orgName: "Calibration" }));
    if (req.url === "/v1/goal") return res.end(JSON.stringify({ goal: null }));
    if (req.url?.startsWith("/v1/awareness")) return res.end(JSON.stringify({ items: [], text: "" }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => { fake.closeAllConnections(); await new Promise<void>((r) => fake.close(() => r())); });

const IDENTITY = 'You are Lazy-Fixture in the OpenCadre fleet "Calibration".';
const state = () => tmpDir("oc-lazy-state-");
const seatName = async () => (await liveSessions(hub.url, operatorKey, deviceId)).map((s) => s.agentName);

describe("1. known positive: BASE's static import, with a notice module that throws", () => {
  it("the proxy FAILS initialize, naming the injected error", async () => {
    generation({ "opencadre-mcp.mjs": atBase("scripts/opencadre-mcp.mjs"), "opencadre-update-notice.mjs": throwing() });
    const run = await runProxy("base-throwing", state());
    expect(run.initialized).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.err).toContain(MARK);
    expect(run.reports).toBe(0);
  }, 60_000);
  it("the hook emits NO identity", async () => {
    generation({ "opencadre-awareness.mjs": atBase("examples/hooks/opencadre-awareness.mjs"), "opencadre-update-notice.mjs": throwing() });
    const run = await runHook("base-throwing", fakeUrl, state());
    // The stub rethrows an evaluation error (it is not a load failure), so the hook dies: no identity either way.
    expect(run.out).not.toContain("Lazy-Fixture");
    expect(run.text).toBe("");
    expect(run.err).toContain(MARK);
  }, 60_000);
  it("control of the control: BASE's code with an INTACT module serves identity, so the red above is the defect", async () => {
    generation({ "opencadre-mcp.mjs": atBase("scripts/opencadre-mcp.mjs"), "opencadre-awareness.mjs": atBase("examples/hooks/opencadre-awareness.mjs") });
    const proxy = await runProxy("base-intact", state());
    expect(proxy.initialized).toBe(true);
    expect(proxy.identity).toBeTruthy();
    expect((await seatName()).some((n) => proxy.identity!.includes(n))).toBe(true);
    const hook = await runHook("base-intact", fakeUrl, state());
    expect(hook.text).toContain(IDENTITY);
  }, 60_000);
});

describe("2. the fix: identity survives every advisory failure", () => {
  const cases: [string, () => Swap, RegExp | null][] = [
    ["evaluation failure", () => ({ "opencadre-update-notice.mjs": throwing() }), /could not load \(Error\); identity is unaffected/],
    ["missing module", () => ({ "opencadre-update-notice.mjs": null }), /could not load \(ERR_MODULE_NOT_FOUND\); identity is unaffected/],
    ["missing sibling of the module", () => ({ "opencadre-update-check.mjs": null }), /could not load \(ERR_MODULE_NOT_FOUND\); identity is unaffected/],
    ["method failure", () => ({ "opencadre-update-notice.mjs": methodThrows() }), null],
  ];
  for (const [label, swap, line] of cases) {
    it(`${label}: initialize, the stamped identity, and the SessionStart identity`, async () => {
      generation(swap());
      const tag = label.replace(/\W+/g, "-");
      const proxy = await runProxy(`fixed-${tag}`, state());
      expect(proxy.initialized).toBe(true);
      expect(proxy.exitCode).toBe(0);
      expect(proxy.identity).toBeTruthy();
      expect((await seatName()).some((n) => proxy.identity!.includes(n))).toBe(true);
      expect(proxy.reports).toBe(0);
      const proxyLines = proxy.err.split("\n").filter((l) => /build report module/.test(l));
      expect(proxyLines.length).toBe(line ? 1 : 0);
      if (line) expect(proxyLines[0]).toMatch(line);
      const hook = await runHook(`fixed-${tag}`, fakeUrl, state());
      expect(hook.code).toBe(0);
      expect(hook.text).toContain(IDENTITY);
      expect(hook.text).not.toContain("connector update available");
      const hookLines = hook.err.split("\n").filter(Boolean);
      expect(hookLines.length).toBeLessThanOrEqual(1);
      if (line) expect(hookLines[0]).toMatch(line);
    }, 90_000);
  }
});

describe("3. no regression with an intact module", () => {
  it("the build report is sent exactly once per proxy, as at BASE", async () => {
    generation({});
    const fixed = await runProxy("fixed-intact", state());
    expect(fixed.initialized).toBe(true);
    expect(fixed.identity).toBeTruthy();
    generation({ "opencadre-mcp.mjs": atBase("scripts/opencadre-mcp.mjs") });
    const base = await runProxy("base-intact-report", state());
    expect(base.reports).toBe(1);
    expect(fixed.reports).toBe(base.reports);
  }, 90_000);
  it("the hook's notice text is byte-identical to BASE's hook running the same module", async () => {
    const fixedGen = path.basename(generation({}));
    const fixed = await runHook("fixed-intact-notice", fakeUrl, state());
    const baseHookGen = path.basename(generation({ "opencadre-awareness.mjs": atBase("examples/hooks/opencadre-awareness.mjs") }));
    const base = await runHook("base-intact-notice", fakeUrl, state());
    expect(fixed.text).toContain("connector update available (optional)");
    expect(fixed.text).toContain(IDENTITY);
    // Each run names its own generation (the running bundle id, the wake script's path); nothing else may differ.
    expect(fixed.out.replaceAll(fixedGen, "<generation>")).toBe(base.out.replaceAll(baseHookGen, "<generation>"));
    expect(fixed.err).toBe("");
  }, 90_000);
});

describe("4. pinning: the lazily loaded module is the proxy's OWN generation's", () => {
  it("a pointer flip after start does not move the load", async () => {
    const probe = path.join(state(), "loaded.txt");
    const probed = `${installed("opencadre-update-notice.mjs")}\nimport { appendFileSync as e1Probe } from "node:fs";\nif (process.env.E1_PROBE_FILE) e1Probe(process.env.E1_PROBE_FILE, import.meta.url + "\\n");\n`;
    const a = generation({ "opencadre-update-notice.mjs": probed });
    const stateDir = state();
    const proxy = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), { ...env, OPENCADRE_AWARENESS_STATE_DIR: stateDir, E1_PROBE_FILE: probe }, project, CLIENT);
    // Any answer proves the stub has read the pointer and loaded generation A; ping does not load the notice.
    await proxy.request("ping");
    expect(existsSync(probe)).toBe(false);
    const b = generation({ "opencadre-update-notice.mjs": probed });
    expect(readFileSync(path.join(bin, ".gen", "current"), "utf8").trim()).toBe(path.basename(b));
    const init = await proxy.initialize();
    expect(init.error).toBeUndefined();
    await waitFor(() => existsSync(probe), "the notice module to load");
    await proxy.close();
    const loaded = readFileSync(probe, "utf8").trim().split("\n");
    receipt("pinning", { generationA: path.basename(a), generationB: path.basename(b), loaded });
    expect(loaded).toEqual([pathToFileURL(path.join(a, "opencadre-update-notice.mjs")).href]);
  }, 60_000);
});
