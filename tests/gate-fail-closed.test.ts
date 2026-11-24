// Board 70f528b2: the approval gate fails CLOSED wherever the harness allows it.
//
// TWO HOLES, BOTH MEASURED BEFORE THIS CHANGE (B:\ai-work\temp\9d1f-gate-failclosed\probe, before.jsonl):
//   1. Cursor. Its hooks fail OPEN unless the entry says `failClosed: true` (cursor.com/docs/hooks): a gate that crashes,
//      times out or cannot start lets the command run. `connect` wrote the gate's beforeShellExecution entry without it,
//      and this machine's own ~/.cursor/hooks.json (CURSOR_HOOKS_PRE_FAILCLOSED, captured) is that install.
//   2. The gate's own crash. Claude Code, Codex and Cursor RUN a command whose pre-hook exits 1 with no decision. A hub
//      answer the gate could not read, or a structurally malformed approval-gate.json, crashed the gate (exit 1, stack
//      trace) on a risky command, and the command ran. Now it is the dialect's deny AND exit 2, which all three block on.
//
// Every test here names the world in which it fails: the writer without the field, the reader that ignores it, the gate
// without its crash handler. No hub is called: the gate tests point at a dead local port and replace `fetch` in the
// child; the doctor tests stub `fetch` in this process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { CURSOR_HOOKS_PRE_FAILCLOSED } from "./fixtures/client-configs.js";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";
import { planCredentials, planCursorSessionServer } from "../cli/lib/device.mjs";
import { runDoctor } from "../cli/lib/doctor.mjs";
import { hostGateInstalled } from "../scripts/opencadre-config.mjs";
import { crashExitFor } from "../scripts/opencadre-hook-dialect.mjs";

vi.setConfig({ testTimeout: 90_000 });

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const GATE = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
const DEAD_HUB = "http://127.0.0.1:9";

const binOf = (home: string) => path.join(home, ".opencadre", "bin");
const hookPaths = (bin: string) => ({
  awarenessPath: path.join(bin, "opencadre-awareness.mjs"), wakePath: path.join(bin, "opencadre-wake.mjs"), usagePath: path.join(bin, "opencadre-usage.mjs"),
  gatePath: path.join(bin, "opencadre-approval-gate.mjs"), stampPath: path.join(bin, "opencadre-session-stamp.mjs"),
});
const hooksFileOf = (home: string) => path.join(home, ".cursor", "hooks.json");
const backupsOf = (file: string) => (existsSync(path.dirname(file)) ? readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-`)) : []);

/** A home connected for Cursor before failClosed: the captured hooks.json for this home's bin, the session server, and a
 * computer credential for a dead local hub (built here, all zeros: never a real one). */
function cursorPreFailClosed(home: string) {
  const bin = binOf(home);
  const hooks = hooksFileOf(home);
  mkdirSync(path.dirname(hooks), { recursive: true });
  // The bin folder and its separator exactly as the writer joined them, escaped for the JSON string they sit in.
  writeFileSync(hooks, CURSOR_HOOKS_PRE_FAILCLOSED.replaceAll("<opencadre-bin>/", JSON.stringify(bin + path.sep).slice(1, -1)));
  const server = planCursorSessionServer({ home, proxyPath: path.join(bin, "opencadre-mcp.mjs") });
  writeFileSync(server.file, server.after);
  const credentials = planCredentials({ home, hub: DEAD_HUB, credential: `dev_${"0".repeat(48)}`, deviceId: "fc-device" });
  mkdirSync(path.dirname(credentials.file), { recursive: true });
  writeFileSync(credentials.file, credentials.after);
  return { hooks, mcp: server.file };
}

const runCli = (args: string[], home: string) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: isolatedCliEnv(home, process.env), windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
const upgrade = (home: string) => runCli(["connect", "--upgrade", "--offline", "--verbose", "--home", home], home);

const stubFetch = () => vi.stubGlobal("fetch", async () => new Response("not here", { status: 404 }));
afterEach(() => vi.unstubAllGlobals());

describe("Cursor: the gate's entry is written failClosed, and only the gate's", () => {
  it("a fresh write puts failClosed on beforeShellExecution and on no other OpenCadre entry", () => {
    const home = tmpDir("oc-fc-fresh-");
    const plan = planSessionHooks({ home, client: "cursor", ...hookPaths(binOf(home)) });
    const hooks = JSON.parse(plan.after).hooks;
    expect(hooks.beforeShellExecution).toEqual([{ command: `node "${path.join(binOf(home), "opencadre-approval-gate.mjs")}" --client cursor`, timeout: 600, failClosed: true }]);
    for (const event of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop", "preToolUse"]) {
      expect(hooks[event], event).toHaveLength(1);
      expect(hooks[event][0], event).not.toHaveProperty("failClosed");
    }
  });

  it("upgrading the captured install adds the field to the one gate entry, changes no other byte, and a second run is identical", () => {
    const home = tmpDir("oc-fc-upgrade-");
    const { hooks } = cursorPreFailClosed(home);
    const before = readFileSync(hooks, "utf8");
    const first = planSessionHooks({ home, client: "cursor", ...hookPaths(binOf(home)) });
    expect(first.before).toBe(before);
    // Exactly one change: `"timeout": 600` gains a following `"failClosed": true`. Nothing duplicated, nothing moved.
    expect(first.after).toBe(before.replace('"timeout": 600\n', '"timeout": 600,\n        "failClosed": true\n'));
    expect(JSON.parse(first.after).hooks.beforeShellExecution).toHaveLength(1);
    // No command moved, so nothing for a hash-trusting client to re-review.
    expect(first.changed).toEqual([]);
    writeFileSync(hooks, first.after);
    const second = planSessionHooks({ home, client: "cursor", ...hookPaths(binOf(home)) });
    expect(second.after).toBe(first.after);
  });

  it("keeps a user's own beforeShellExecution hook, in place and fail-open, beside ours", () => {
    const home = tmpDir("oc-fc-foreign-");
    const { hooks } = cursorPreFailClosed(home);
    const config = JSON.parse(readFileSync(hooks, "utf8"));
    config.hooks.beforeShellExecution.unshift({ command: "node my-own-audit.mjs", timeout: 5 });
    writeFileSync(hooks, `${JSON.stringify(config, null, 2)}\n`);
    const after = JSON.parse(planSessionHooks({ home, client: "cursor", ...hookPaths(binOf(home)) }).after);
    expect(after.hooks.beforeShellExecution[0]).toEqual({ command: "node my-own-audit.mjs", timeout: 5 });
    expect(after.hooks.beforeShellExecution[1]).toMatchObject({ timeout: 600, failClosed: true });
    expect(after.hooks.beforeShellExecution).toHaveLength(2);
  });
});

describe("Cursor: connect --upgrade, doctor and the config reader on the captured install", () => {
  it("doctor sends the old entry to upgrade; connect --upgrade adds failClosed once, backs up, and doctor goes quiet", async () => {
    const home = tmpDir("oc-fc-reconcile-");
    const { hooks, mcp } = cursorPreFailClosed(home);
    const before = readFileSync(hooks, "utf8");
    const mcpBefore = readFileSync(mcp, "utf8");
    stubFetch();
    // The reader still recognises the gate (so a Claude Code gate inside Cursor stands down), and doctor still reads
    // the install as present -- but not as healthy.
    expect(hostGateInstalled("cursor", { home })).toBe(true);
    const pre = await runDoctor({ client: "cursor", home });
    const preText = pre.lines.join("\n");
    expect(preText).toMatch(/hooks=present/);
    expect(preText).toMatch(/gate_fail_closed=missing/);
    expect(preText).toMatch(/verdict=gate_outdated/);
    expect(preText).toContain("is not marked failClosed, so Cursor runs a risky command whenever the gate crashes, times out or cannot start");
    expect(pre.healthy).toBe(false);

    const r = await upgrade(home);
    // Exit 3, user action: reconcile does not know whether Cursor records approval per hook (TRUST_MODEL "unknown"),
    // so a changed hooks file is always followed by "check Cursor's hooks settings once".
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.out).toContain("Cursor may ask you to allow the changed OpenCadre hooks");
    const after = readFileSync(hooks, "utf8");
    expect(after).toBe(before.replace('"timeout": 600\n', '"timeout": 600,\n        "failClosed": true\n'));
    expect(r.out).toContain(`${hooks}: changed (previous version kept as`);
    expect(r.out).toContain("beforeShellExecution approval gate: failClosed changed");
    const baks = backupsOf(hooks);
    expect(baks).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(hooks), baks[0]), "utf8")).toBe(before);
    expect(readFileSync(mcp, "utf8")).toBe(mcpBefore);

    expect(hostGateInstalled("cursor", { home })).toBe(true);
    const post = await runDoctor({ client: "cursor", home });
    const postText = post.lines.join("\n");
    expect(postText).toMatch(/hooks=present/);
    expect(postText).not.toMatch(/gate_fail_closed|not marked failClosed|gate_outdated/);

    // Idempotent: the second upgrade writes nothing and makes no second backup.
    const again = await upgrade(home);
    expect(again.code, again.out + again.err).toBe(0);
    expect(readFileSync(hooks, "utf8")).toBe(after);
    expect(backupsOf(hooks)).toEqual(baks);
    expect(again.out).toContain(`${hooks}: unchanged (already current)`);
  });
});

// ---- the gate's own error path ---------------------------------------------------------------------------------------

const CLIENTS = ["claude-code", "codex", "cursor"] as const;
type Client = (typeof CLIENTS)[number];
type Run = { code: number | null; out: string; err: string };

/** A git repository on an unprotected branch: a force-push there reaches the branch check, where a malformed
 * `protectedBranches` throws. */
function featureRepo() {
  const repo = tmpDir("oc-fc-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore", windowsHide: true });
  git("init", "-q", "-b", "feature-x");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  return repo;
}

function payload(client: Client, command: string, cwd: string) {
  if (client === "cursor") return { conversation_id: "conv-fc", generation_id: "g", hook_event_name: "beforeShellExecution", command, cwd, workspace_roots: [cwd] };
  if (client === "codex") return { session_id: "fc", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ["bash", "-lc", command] }, cwd };
  return { session_id: "fc", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}

/** The injected hub-client faults, as preload modules: `null` makes the gate's first read of the hub's answer throw
 * outside any try; `throw` makes fetch itself throw synchronously. Neither reaches the network. */
const PRELOAD = {
  null: "globalThis.fetch = async () => null;\n",
  throw: 'globalThis.fetch = () => { throw new RangeError("injected hub client failure"); };\n',
};

function runGate(client: Client, command: string, opts: { cwd: string; mode: string; config?: object; preload?: keyof typeof PRELOAD; preloadSource?: string }): Promise<Run> {
  const home = tmpDir("oc-fc-home-");
  const args: string[] = [];
  const source = opts.preloadSource ?? (opts.preload ? PRELOAD[opts.preload] : undefined);
  if (source) {
    const file = path.join(home, "preload.mjs");
    writeFileSync(file, source);
    args.push("--import", pathToFileURL(file).href);
  }
  let gateConfig = "";
  if (opts.config) {
    gateConfig = path.join(home, "gate.json");
    writeFileSync(gateConfig, JSON.stringify(opts.config));
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, GATE, "--client", client], {
      cwd: opts.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home,
        CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
        OPENCADRE_URL: DEAD_HUB, OPENCADRE_KEY: "placeholder-not-a-key",
        OPENCADRE_GATE_MODE: opts.mode, OPENCADRE_APPROVER: "", OPENCADRE_APPROVAL_WAIT: "1",
        OPENCADRE_GATE_CONFIG: gateConfig, OPENCADRE_GATE_WARN: "silent", OPENCADRE_GATE_SHELL: "posix",
      },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload(client, command, opts.cwd)));
  });
}

/** Blocked on the crash path: the dialect's deny on stdout, the reason on stderr, and exit 2, which Claude Code, Codex
 * and Cursor each block on whatever was printed. */
function expectCrashDeny(client: Client, r: Run, why: RegExp) {
  expect(r.code, `stdout: ${r.out}\nstderr: ${r.err}`).toBe(2);
  const said = JSON.parse(r.out);
  const reason = client === "cursor" ? said.user_message : said.hookSpecificOutput?.permissionDecisionReason;
  if (client === "cursor") expect(said).toMatchObject({ permission: "deny", agent_message: reason });
  else expect(said).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  expect(reason).toMatch(/^OpenCadre approval gate failed \(.+\) on a command it holds as risky, so the command was blocked \(fail closed\)\./);
  expect(reason).toMatch(why);
  expect(r.err).toContain(reason);
  expect(r.out).not.toMatch(/"allow"/);
}

describe("the dialect names the crash exit for each harness", () => {
  it("exit 2 for Claude Code, Codex and Cursor; a blockExit row keeps its own; the undocumented keep none", () => {
    expect(CLIENTS.map((c) => crashExitFor(c))).toEqual([2, 2, 2]);
    expect(crashExitFor("windsurf")).toBe(2);
    expect(crashExitFor("qwen")).toBeUndefined();
    expect(crashExitFor("gemini")).toBeUndefined();
  });
});

describe.each(CLIENTS)("the gate fails closed on its own crash, for a risky command: %s", { timeout: SPAWN_TEST_TIMEOUT_MS }, (client) => {
  it("a hub client whose answer cannot be read (it threw outside any try): blocked, not run", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    expectCrashDeny(client, await runGate(client, "rm -rf ./src", { cwd, mode: "ask", preload: "null" }), /reading 'status'/);
  });

  it("a malformed approval-gate.json that throws after the rules matched (protectedBranches: 5): blocked", async () => {
    const cwd = featureRepo();
    const r = await runGate(client, "git push --force origin feature-y", { cwd, mode: "ask", config: { protectedBranches: 5 } });
    expectCrashDeny(client, r, /protectedBranches/);
  });

  it("a malformed rule that throws before the rules finished: the built-in rules still hold rm -rf, so it is blocked", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const config = { useDefaultRules: false, rules: [{ category: "mine", pattern: "x", psCheck: "__proto__" }] };
    expectCrashDeny(client, await runGate(client, "rm -rf ./src", { cwd, mode: "ask", config }), /is not a function/);
  });

  // CONTROLS: what this change deliberately leaves as it was.
  it("CONTROL: the same malformed rule on a command no built-in rule holds keeps the old crash (exit 1, no decision)", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const config = { useDefaultRules: false, rules: [{ category: "mine", pattern: "x", psCheck: "__proto__" }] };
    const r = await runGate(client, "echo hi", { cwd, mode: "ask", config });
    expect(r.code, r.err).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/TypeError: .*is not a function/);
  });

  it("CONTROL: a benign command with the broken hub client never reaches the hub, and passes as before", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const r = await runGate(client, "echo hi", { cwd, mode: "ask", preload: "null" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(client === "cursor" ? "{}" : "");
  });

  // A CHANGE, not a control: this crash used to exit 1, which Cursor (now failClosed) would have blocked.
  it("in notify mode the gate has decided to let the command run, and a crash while recording it keeps that decision", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const r = await runGate(client, "rm -rf ./src", { cwd, mode: "notify", preload: "throw" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(client === "cursor" ? "{}" : "");
  });

  it("CONTROL: a fetch that throws inside the approval request was already caught, and stays the same exit-0 deny", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const r = await runGate(client, "rm -rf ./src", { cwd, mode: "ask", preload: "throw" });
    expect(r.code, r.err).toBe(0);
    const said = JSON.parse(r.out);
    expect(client === "cursor" ? said.permission : said.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.out).toContain("an unexpected error (injected hub client failure)");
  });
});

// Olive's review of fd30271a (P2): the crash handler formatted the thrown value, and three shapes of value made that
// formatting throw INSIDE the handler, so Node ended the run with exit 7 and an empty stdout: no deny, and Claude Code
// and Codex ran the command (receipt: B:/ai-work/temp/olive-gate-failclosed-fd30271a/adversarial.json). Each shape is
// injected after the command is classified risky, on two crash routes:
//   getter    OLIVE'S 18 CONTROLS, exactly as she ran them (6 shapes x 3 clients): the hub answer's `status` getter
//             throws it, so the top-level await rejects (uncaughtException). Red on 73e6d6f0 for the 3 bad shapes.
//   floating  OUR OWN EXTRA EVIDENCE, not part of her receipt: fetch leaves the same value as a rejection nobody handles,
//             and never answers (unhandledRejection), so the second handler is held to the same contract.
// A bad shape must still be the dialect's deny with exit 2, on the FIXED reason (nothing read from the value); a good
// shape keeps its message in the reason, as before.
const THROWN = {
  nullproto: { value: "Object.create(null)", bad: true },
  badmessage: { value: "({ message: { toString: 1 } })", bad: true },
  throwgetter: { value: '({ get message() { throw new Error("nested formatter failure"); } })', bad: true },
  error: { value: 'new Error("injected status getter failure")', bad: false, why: /injected status getter failure/ },
  text: { value: '"injected primitive rejection"', bad: false, why: /injected primitive rejection/ },
  nil: { value: "null", bad: false, why: /\(null\)/ },
} as const;
const ROUTES = {
  getter: (value: string) => `globalThis.fetch = async () => ({ get status() { throw ${value}; } });\n`,
  floating: (value: string) => `globalThis.fetch = () => { Promise.reject(${value}); return new Promise(() => {}); };\n`,
} as const;
const FIXED_REASON = "OpenCadre approval gate failed on a command it holds as risky, so the command was blocked (fail closed). Ask the user before trying another way.";
const CASES = CLIENTS.flatMap((client) => Object.keys(ROUTES).flatMap((route) => Object.keys(THROWN).map((shape) => [client, route, shape] as const)));

describe.each(CASES)("the crash handler cannot fail itself: %s, %s route, thrown %s", { timeout: SPAWN_TEST_TIMEOUT_MS }, (client, route, shape) => {
  it("blocks with the dialect's deny and exit 2", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    const thrown = THROWN[shape];
    const r = await runGate(client, "rm -rf ./src", { cwd, mode: "ask", preloadSource: ROUTES[route](thrown.value) });
    expect(r.code, `stdout: ${r.out}\nstderr: ${r.err}`).toBe(2);
    const said = JSON.parse(r.out);
    const reason = client === "cursor" ? said.user_message : said.hookSpecificOutput?.permissionDecisionReason;
    if (client === "cursor") expect(said).toEqual({ permission: "deny", user_message: reason, agent_message: reason });
    else expect(said).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    if (thrown.bad) expect(reason).toBe(FIXED_REASON);
    else expectCrashDeny(client, r, thrown.why);
    expect(r.err).toContain(reason);
  });
});

describe.each(CLIENTS)("CONTROL: a bad thrown value never turns a benign command into a deny: %s", { timeout: SPAWN_TEST_TIMEOUT_MS }, (client) => {
  it("a crash before classification on a command no built-in rule holds keeps exit 1, whatever was thrown", async () => {
    const cwd = tmpDir("oc-fc-cwd-");
    // The malformed rule throws a TypeError during classification; the preload makes every stack unprintable, so even
    // printing the crash fails, and the exit code must still be the old one. A getter on TypeError.prototype would not
    // do this: each TypeError instance carries its own `stack`, which shadows it. Error.prepareStackTrace runs on the
    // first read of any instance's stack, so throwing there is what really makes printing fail.
    const config = { useDefaultRules: false, rules: [{ category: "mine", pattern: "x", psCheck: "__proto__" }] };
    const preloadSource = 'Error.prepareStackTrace = () => { throw new Error("unprintable"); };\n';
    const r = await runGate(client, "echo hi", { cwd, mode: "ask", config, preloadSource });
    expect(r.code, r.err).toBe(1);
    expect(r.out).toBe("");
  });
});
