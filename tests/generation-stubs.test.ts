// Entry stubs (cli/lib/stubs.mjs): what each one does when it CANNOT load its generation, per client dialect
// (049a's §2b-2: "a stub-load failure produces the client's own blocking response, per dialect. Exit 2 alone is not
// universal"), and that a working stub is the generation module itself (same exports, same main path).
//
// THE REFERENCE IS THE REAL GATE, not the stub's own table. For every client, the installed gate is run for real on a
// risky command with its hub unreachable in strict mode, which it denies; the stub's failure answer must be that same
// deny (same exit code, same JSON shape, only the reason text differs). A stub table derived wrongly from the dialect
// would disagree with the gate here even though it agrees with itself.
import { describe, expect, it, beforeAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { ENTRIES, HELPERS, helperSource } from "../cli/lib/helpers.mjs";
import { exportNames } from "../cli/lib/imports.mjs";
import { STUB_CLIENTS, STUB_DENY_REASON, stubText } from "../cli/lib/stubs.mjs";
import { generationPath, installHelpers, readPointer } from "../cli/lib/generations.mjs";

// Each test installs whole generations (tens of files, fsynced); on a shared, loaded box that outlasts the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Run = { code: number | null; out: string; err: string };
const run = (script: string, args: string[], input: string, env: Record<string, string> = {}) =>
  new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out, err }));
  });

/** Runs `jobs` with at most `n` in flight (children are real processes; the box is shared). */
async function limited<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }));
  return results;
}

// One payload every dialect reads a shell command from (each client's own field is present).
const PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse", event: "PreToolUse", hookName: "tool_call", agent_action_name: "pre_run_command",
  tool_name: "Bash", tool_input: { command: "rm -rf /x" }, command: "rm -rf /x", session_id: "s1", sessionId: "s1",
  conversationId: "c1", workspacePaths: [], toolCall: { name: "run_command", args: { CommandLine: "rm -rf /x" } },
  tool_info: { command_line: "rm -rf /x", cwd: "." }, trajectory_id: "t1", toolName: "bash", toolArgs: "{\"command\":\"rm -rf /x\"}",
  tool_call: { name: "run_commands", input: { commands: ["rm -rf /x"] } }, sessionContext: { rootSessionId: "s1" }, cwd: ".",
});

/** Every string leaf replaced by "S": two answers with the same shape and different reasons compare equal. */
const shape = (out: string): unknown => {
  if (out === "") return "";
  const walk = (v: unknown): unknown => (typeof v === "string" ? "S" : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(JSON.parse(out));
};

let home: string;
let bin: string;
const envFor = (h: string) => ({ HOME: h, USERPROFILE: h, OPENCADRE_HOOK_HOME: h });

beforeAll(() => {
  home = tmpDir("oc-stub-home-");
  bin = path.join(home, ".opencadre", "bin");
  installHelpers(bin);
});

/** A copy of the installed bin (stubs + generation) broken one way. */
function broken(how: "no-pointer" | "malformed-pointer" | "missing-tree" | "partial-tree", partial = ["opencadre-hook-dialect.mjs"]): string {
  const h = tmpDir(`oc-stub-${how}-`);
  const b = path.join(h, ".opencadre", "bin");
  installHelpers(b);
  const id = readPointer(b).id!;
  if (how === "no-pointer") rmSync(path.join(b, ".gen", "current"));
  if (how === "malformed-pointer") writeFileSync(path.join(b, ".gen", "current"), "not-a-generation\n");
  if (how === "missing-tree") renameSync(generationPath(b, id), path.join(b, ".gen", "moved-away"));
  // The entry itself is there; a module its closure imports is not.
  if (how === "partial-tree") for (const name of partial) rmSync(path.join(generationPath(b, id), ...name.split("/")));
  return h;
}

const MODES = ["no-pointer", "malformed-pointer", "missing-tree", "partial-tree"] as const;

describe("the approval gate stub fails CLOSED in every client's own dialect", () => {
  // The reference: the real gate, loaded through a healthy stub, denying a risky command with its hub unreachable.
  let reference: Run[];
  beforeAll(async () => {
    reference = await limited(4, STUB_CLIENTS.map((client) => () =>
      run(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", client], PAYLOAD, {
        ...envFor(home), OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "test-not-a-key", OPENCADRE_POLICY_TIMEOUT_MS: "500",
      })));
    // The reference must itself be a deny for every client, or it proves nothing.
    for (const [i, ref] of reference.entries()) expect(ref.code === 0 ? ref.out : "exit", `reference gate for ${STUB_CLIENTS[i]}`).toMatch(/deny|block|overrideInput|exit/);
  }, 300_000);

  for (const mode of MODES) {
    it(`${mode}: answers exactly the real gate's deny (exit code and shape) for every client`, async () => {
      const h = broken(mode);
      const failures = await limited(4, STUB_CLIENTS.map((client) => async () => ({
        client, r: await run(path.join(h, ".opencadre", "bin", "opencadre-approval-gate.mjs"), ["--client", client], PAYLOAD, envFor(h)),
      })));
      const mismatches: string[] = [];
      for (const { client, r } of failures) {
        const ref = reference[STUB_CLIENTS.indexOf(client)];
        if (r.code !== ref.code) mismatches.push(`${client}: exit ${r.code}, the gate denies with ${ref.code}`);
        else if (JSON.stringify(shape(r.out)) !== JSON.stringify(shape(ref.out))) mismatches.push(`${client}: ${r.out} is not the shape of ${ref.out}`);
        // Why is always on stderr (Windsurf and Droid show it; the others log it).
        if (!/could not load opencadre-approval-gate\.mjs/.test(r.err)) mismatches.push(`${client}: no reason on stderr`);
      }
      expect(mismatches).toEqual([]);
      // And the stdout reason is the fixed one, so the stub's bytes do not depend on the failure.
      const claude = failures.find((f) => f.client === "claude-code")!.r;
      expect(JSON.parse(claude.out).hookSpecificOutput.permissionDecisionReason).toBe(STUB_DENY_REASON);
    }, 300_000);
  }

  it("an unknown --client gets the default (Claude Code) deny, never a pass", async () => {
    const h = broken("no-pointer");
    const r = await run(path.join(h, ".opencadre", "bin", "opencadre-approval-gate.mjs"), ["--client", "no-such-tool"], PAYLOAD, envFor(h));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
  }, 120_000);

  it("--report and --typed-commit are never a decision: the client's no-opinion, and why on stderr", async () => {
    const h = broken("missing-tree");
    const gate = path.join(h, ".opencadre", "bin", "opencadre-approval-gate.mjs");
    for (const [flag, client, silence] of [["--typed-commit", "devin", ""], ["--report", "codex", ""], ["--typed-commit", "cursor", "{}"]] as const) {
      const r = await run(gate, [flag, "--client", client], PAYLOAD, envFor(h));
      expect(r.code, `${flag} ${client}`).toBe(0);
      expect(r.out, `${flag} ${client}`).toBe(silence);
      expect(r.err).toMatch(/Nothing was recorded/);
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("the other stubs, when their generation cannot load", () => {
  it("the gate loader exits 2 (the loader's contract; every client it is installed for blocks on 2)", async () => {
    for (const mode of MODES) {
      const h = broken(mode);
      for (const client of ["windsurf", "devin", "droid", "crush"]) {
        const r = await run(path.join(h, ".opencadre", "bin", "opencadre-approval-gate-loader.mjs"), ["--client", client], PAYLOAD, envFor(h));
        expect(r.code, `${client}/${mode}`).toBe(2);
        expect(r.err).toMatch(/blocked/);
      }
    }
  }, 300_000);

  it("the Cline hook cancels a run_commands call or an unreadable payload, and says {} to anything else", async () => {
    for (const mode of MODES) {
      const h = broken(mode);
      const hook = path.join(h, ".opencadre", "bin", "opencadre-cline-hook.mjs");
      const shell = await run(hook, [], JSON.stringify({ hookName: "tool_call", tool_call: { name: "run_commands", input: { commands: ["rm -rf /x"] } } }), envFor(h));
      expect(JSON.parse(shell.out).cancel, mode).toBe(true);
      const garbage = await run(hook, [], "not json", envFor(h));
      expect(JSON.parse(garbage.out).cancel, mode).toBe(true);
      const result = await run(hook, [], JSON.stringify({ hookName: "tool_result", tool_result: {} }), envFor(h));
      expect(result.out, mode).toBe("{}");
      expect(result.code).toBe(0);
    }
  }, 300_000);

  it("non-safety hooks say the client's no-opinion, exit 0, and say why on stderr", async () => {
    const h = broken("malformed-pointer");
    const b = path.join(h, ".opencadre", "bin");
    const cases: [string, string, string][] = [
      ["opencadre-awareness.mjs", "claude-code", ""], ["opencadre-awareness.mjs", "cursor", "{}"], ["opencadre-awareness.mjs", "cline", "{}"],
      ["opencadre-session-stamp.mjs", "codex", ""], ["opencadre-session-stamp.mjs", "cursor", "{}"], ["opencadre-wake.mjs", "claude-code", ""],
      ["opencadre-usage.mjs", "codex", ""], ["opencadre-antigravity.mjs", "antigravity", ""],
    ];
    for (const [script, client, silence] of cases) {
      const r = await run(path.join(b, script), ["--client", client], "{}", envFor(h));
      // Exit 0: a Claude Code Stop hook exiting 2 would WAKE the model (asyncRewake), and Antigravity denies on non-zero.
      expect(r.code, `${script} ${client}`).toBe(0);
      expect(r.out, `${script} ${client}`).toBe(silence);
      expect(r.err, script).toMatch(/could not load .* Skipped/);
    }
  }, 120_000);

  it("the MCP proxy exits 1 with the reason (a server that fails to start is not fatal to its client)", async () => {
    const h = broken("missing-tree");
    const r = await run(path.join(h, ".opencadre", "bin", "opencadre-mcp.mjs"), ["--client", "codex"], "", envFor(h));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/could not load opencadre-mcp\.mjs/);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("plugin stubs export a plugin that BLOCKS shell commands the way each client's real plugin denies one", async () => {
    for (const mode of MODES) {
      // Partial: a module in each plugin's own closure is gone (Kilo and Amp import pure-ack; OpenCode imports mail.js).
      const h = broken(mode, ["pure-ack.mjs", "opencode-plugin/mail.js"]);
      const b = path.join(h, ".opencadre", "bin");
      // Kilo: the single export's `tool.execute.before` throws for bash (Kilo turns a throw into a refused call).
      const kilo = await import(pathToFileURL(path.join(b, "opencadre-kilo-plugin.js")).href);
      expect(Object.keys(kilo)).toEqual(["OpenCadre"]);
      const hooks = await kilo.OpenCadre({});
      await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "rm -rf /x" } })).rejects.toThrow(/blocked/);
      await expect(hooks["tool.execute.before"]({ tool: "read", sessionID: "s" }, { args: {} })).resolves.toBeUndefined();
      // Amp: `tool.call` on a shell command answers reject-and-continue.
      const amp = await import(pathToFileURL(path.join(b, "opencadre-amp-plugin.mjs")).href);
      const handlers: Record<string, (e: unknown) => unknown> = {};
      amp.default({ on: (event: string, fn: (e: unknown) => unknown) => (handlers[event] = fn), helpers: { shellCommandFromToolCall: (e: { input?: { cmd?: string } }) => (e.input?.cmd ? { command: e.input.cmd } : null) } });
      expect(await handlers["tool.call"]({ tool: "Bash", input: { cmd: "rm -rf /x" }, thread: { id: "t" } })).toMatchObject({ action: "reject-and-continue" });
      expect(await handlers["tool.call"]({ tool: "Read", input: {}, thread: { id: "t" } })).toBeUndefined();
      // OpenCode: its permission hook sets a shell evaluation to deny.
      const opencode = await import(pathToFileURL(path.join(b, "opencode-plugin", "index.js")).href);
      let evaluate: ((e: Record<string, unknown>) => Promise<void>) | undefined;
      await opencode.default.setup({ permission: { hook: async (_: string, fn: typeof evaluate) => { evaluate = fn; } } });
      const shellEvent: Record<string, unknown> = { action: "shell", resources: ["rm -rf /x"] };
      await evaluate!(shellEvent);
      expect(shellEvent.effect).toBe("deny");
      const readEvent: Record<string, unknown> = { action: "read" };
      await evaluate!(readEvent);
      expect(readEvent.effect).toBeUndefined();
    }
  }, 60_000);
});

describe("review: OpenCode deferred dependencies cannot bypass the denying plugin", () => {
  for (const missing of ["opencadre-config.mjs", "opencode-plugin/clearance.js"]) {
    it(`blocks shell commands when ${missing} is absent`, async () => {
      const h = broken("partial-tree", [missing]);
      const plugin = await import(pathToFileURL(path.join(h, ".opencadre", "bin", "opencode-plugin", "index.js")).href);
      let evaluate: ((event: Record<string, unknown>) => Promise<void>) | undefined;
      await plugin.default.setup({ permission: { hook: async (_: string, fn: typeof evaluate) => { evaluate = fn; } } });
      expect(evaluate, "a broken installed plugin must register a denying shell hook").toBeTypeOf("function");
      const shell: Record<string, unknown> = { action: "shell", resources: ["rm -rf /x"] };
      await evaluate!(shell);
      expect(shell.effect).toBe("deny");
      const read: Record<string, unknown> = { action: "read" };
      await evaluate!(read);
      expect(read.effect).toBeUndefined();
    });
  }
});

describe("a working stub IS its generation's module", () => {
  it("a plugin stub re-exports exactly the generation module's export names (Kilo calls every exported function)", async () => {
    for (const name of Object.keys(ENTRIES).filter((n) => ENTRIES[n as keyof typeof ENTRIES].endsWith("plugin"))) {
      const id = readPointer(bin).id!;
      const viaStub = await import(pathToFileURL(path.join(bin, ...name.split("/"))).href);
      const direct = await import(pathToFileURL(path.join(generationPath(bin, id), ...name.split("/"))).href);
      expect(Object.keys(viaStub).sort(), name).toEqual(Object.keys(direct).sort());
      // The parser the stub generator uses agrees with what the module really exports.
      expect(exportNames(readFileSync(path.join(generationPath(bin, id), ...name.split("/")), "utf8")), name).toEqual(Object.keys(direct).sort());
      for (const k of Object.keys(direct)) expect(viaStub[k], `${name} ${k}`).toBe(direct[k]);
    }
  }, 30_000);

  it("stub bytes do not depend on the generation: the same for two different trees", () => {
    for (const name of Object.keys(ENTRIES)) {
      const text = readFileSync(helperSource(name), "utf8");
      expect(stubText(name, text), name).toBe(stubText(name, `${text}\n// another revision\n`));
    }
  });

  it("no helper decides 'am I the main module' (a stub imports it, so such a check would skip its main path)", () => {
    for (const name of Object.keys(HELPERS)) {
      const text = readFileSync(helperSource(name), "utf8");
      expect(text, name).not.toMatch(/process\.argv\[1\]|import\.meta\.main|require\.main/);
    }
  });

  it("every executed entry still runs its main path through the stub (the gate answers a real payload)", async () => {
    // A healthy install: the gate reads stdin and argv through the stub and answers in Cursor's dialect.
    const r = await run(path.join(bin, "opencadre-approval-gate.mjs"), ["--client", "cursor"], PAYLOAD, {
      ...envFor(home), OPENCADRE_GATE_MODE: "strict", OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "test-not-a-key", OPENCADRE_POLICY_TIMEOUT_MS: "500",
    });
    expect(JSON.parse(r.out).permission).toBe("deny");
    expect(r.out).toMatch(/hub unreachable/);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("writes a stub for every entry and nothing else at the root", () => {
    const rootFiles = readdirSync(bin).filter((f) => !f.startsWith("."));
    expect(rootFiles.sort()).toEqual([...new Set(Object.keys(ENTRIES).map((n) => n.split("/")[0]))].sort());
    expect(readdirSync(path.join(bin, "opencode-plugin"))).toEqual(["index.js"]);
  });
});
