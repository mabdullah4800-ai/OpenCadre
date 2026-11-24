import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { gateTimeoutFor, registerClearance, runGate } from "../examples/opencode-plugin/clearance.js";

function capturedHook({ location = "C:/repo" } = {}) {
  let permissionHandler;
  let toolHandler;
  const ctx = {
    session: { get: vi.fn(async () => ({ data: { location: { directory: location } } })) },
    permission: { hook: vi.fn((name, fn) => { expect(name).toBe("evaluate"); permissionHandler = fn; }) },
    tool: { hook: vi.fn((name, fn) => { expect(name).toBe("execute.before"); toolHandler = fn; }) },
  };
  return {
    ctx,
    invoke: async (event, { command = event.resources?.join(" && "), workdir, capture = true } = {}) => {
      event.source ??= { type: "tool", id: "call_1" };
      if (capture) await toolHandler({ tool: "shell", sessionID: event.sessionID, id: event.source.id, input: { command, workdir } });
      await permissionHandler(event);
    },
  };
}

function script(source) {
  const cwd = tmpDir("opencode-gate-test-");
  const gatePath = join(cwd, "gate.mjs");
  writeFileSync(gatePath, source);
  return { cwd, gatePath };
}
const gateArgs = (extra) => ({ command: "echo hello", sessionID: "ses_A", nodePath: process.execPath, ...extra });

beforeEach(() => {
  const active = globalThis.__opencadreOpenCodeClearance;
  if (active) for (const record of active.values()) clearTimeout(record.timer);
  delete globalThis.__opencadreOpenCodeClearance;
});

describe("OpenCode clearance adapter", () => {
  it("registers both hooks only once for repeated setup of the same context", async () => {
    const { ctx } = capturedHook();
    await registerClearance(ctx);
    await registerClearance(ctx);
    expect(ctx.permission.hook).toHaveBeenCalledTimes(1);
    expect(ctx.tool.hook).toHaveBeenCalledTimes(1);
  });

  it("gates the complete compound command once, even when OpenCode splits permission resources", async () => {
    const { ctx, invoke } = capturedHook();
    const gate = vi.fn(async () => ({ decision: "deny", reason: "Operator denied this command." }));
    await registerClearance(ctx, { gate });
    const event = { sessionID: "ses_A", action: "shell", resources: ["git checkout main", "git push --force"], effect: "allow" };
    await invoke(event, { command: "git checkout main && git push --force" });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith({ command: "git checkout main && git push --force", sessionID: "ses_A", cwd: "C:/repo" });
    expect(event.effect).toBe("deny");
    expect(event.message).toBe("Operator denied this command.");
  });

  it("uses the shell tool's workdir for project-sensitive gate rules", async () => {
    const { ctx, invoke } = capturedHook({ location: process.cwd() });
    const gate = vi.fn(async () => ({ decision: "pass" }));
    await registerClearance(ctx, { gate });
    const event = { sessionID: "ses_A", action: "shell", resources: ["echo hi"], effect: "allow" };
    await invoke(event, { command: "echo hi", workdir: "subdir" });
    expect(gate).toHaveBeenCalledWith({ command: "echo hi", sessionID: "ses_A", cwd: join(process.cwd(), "subdir") });
  });

  it("fails closed if execute.before did not record the full command", async () => {
    const { ctx, invoke } = capturedHook();
    const gate = vi.fn();
    await registerClearance(ctx, { gate });
    const event = { sessionID: "ses_A", action: "shell", resources: ["git checkout main", "git push --force"], effect: "allow" };
    await invoke(event, { capture: false });
    expect(event.effect).toBe("deny");
    expect(event.message).toMatch(/full command/);
    expect(gate).not.toHaveBeenCalled();
  });

  it("shares one in-flight decision across project plugin instances for the same call id", async () => {
    const a = capturedHook();
    const b = capturedHook();
    const gate = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return { decision: "allow" }; });
    await registerClearance(a.ctx, { gate });
    await registerClearance(b.ctx, { gate });
    const eventA = { sessionID: "ses_A", action: "shell", resources: ["rm -rf old"], effect: "ask" };
    const eventB = { sessionID: "ses_A", action: "shell", resources: ["rm -rf old"], effect: "ask" };
    await Promise.all([a.invoke(eventA, { command: "rm -rf old" }), b.invoke(eventB, { command: "rm -rf old" })]);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(eventA.effect).toBe("allow");
    expect(eventB.effect).toBe("allow");
  });

  it("keeps a native denial and ignores unrelated actions", async () => {
    const { ctx, invoke } = capturedHook();
    const gate = vi.fn();
    await registerClearance(ctx, { gate });
    const nativeDenied = { sessionID: "ses_A", action: "shell", resources: ["rm -rf old"], effect: "deny" };
    const unrelated = { sessionID: "ses_A", action: "edit", resources: ["file"], effect: "allow" };
    await invoke(nativeDenied);
    await invoke(unrelated);
    expect(nativeDenied.effect).toBe("deny");
    expect(unrelated.effect).toBe("allow");
    expect(gate).not.toHaveBeenCalled();
    expect(ctx.session.get).not.toHaveBeenCalled();
  });

  it("fails closed when the session directory cannot be established", async () => {
    const { ctx, invoke } = capturedHook({ location: null });
    const gate = vi.fn();
    await registerClearance(ctx, { gate });
    const event = { sessionID: "ses_A", action: "shell", resources: ["echo hi"], effect: "allow" };
    await invoke(event);
    expect(event.effect).toBe("deny");
    expect(gate).not.toHaveBeenCalled();
  });

  it("fails closed and explains a gate exception or an invalid result", async () => {
    for (const gate of [async () => { throw new Error("helper stopped"); }, async () => null]) {
      const { ctx, invoke } = capturedHook();
      await registerClearance(ctx, { gate });
      const event = { sessionID: "ses_A", action: "shell", resources: ["echo hi"], effect: "allow", source: { type: "tool", id: String(Math.random()) } };
      await invoke(event);
      expect(event.effect).toBe("deny");
      expect(event.message).toMatch(/helper/);
    }
  });

  it("extends the parent timeout to cover a configured human approval wait", () => {
    const cwd = tmpDir("opencode-long-wait-");
    mkdirSync(join(cwd, ".opencadre"));
    writeFileSync(join(cwd, ".opencadre", "approval-gate.json"), JSON.stringify({ waitSeconds: 900 }));
    const previous = process.env.OPENCADRE_APPROVAL_WAIT;
    delete process.env.OPENCADRE_APPROVAL_WAIT;
    try {
      expect(gateTimeoutFor(cwd)).toBe(950_000);
      process.env.OPENCADRE_APPROVAL_WAIT = "1200";
      expect(gateTimeoutFor(cwd)).toBe(1_250_000);
    } finally {
      if (previous === undefined) delete process.env.OPENCADRE_APPROVAL_WAIT;
      else process.env.OPENCADRE_APPROVAL_WAIT = previous;
    }
  });

  it("runs the shared gate for a harmless command without contacting the hub", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const gatePath = join(here, "..", "examples", "hooks", "opencadre-approval-gate.mjs");
    expect(await runGate(gateArgs({ command: "echo hello", sessionID: "ses_safe", cwd: here, gatePath }))).toEqual({ decision: "pass" });
  });

  it("the real gate holds a branch-changing compound command that its push fragment alone would miss", async () => {
    const cwd = tmpDir("opencode-branch-gate-");
    execFileSync("git", ["init", "-b", "feature"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init"], { cwd, stdio: "ignore" });
    const gatePath = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "hooks", "opencadre-approval-gate.mjs");
    const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, OPENCADRE_HOOK_HOME: cwd,
      OPENCADRE_URL: "", OPENCADRE_KEY: "", OPENCADRE_GATE_MODE: "ask", OPENCADRE_GATE_CONFIG: "" };
    const full = await runGate(gateArgs({ cwd, gatePath, env, command: "git checkout main && git push --force" }));
    const fragment = await runGate(gateArgs({ cwd, gatePath, env, command: "git push --force" }));
    expect(full.decision).toBe("deny");
    expect(fragment).toEqual({ decision: "pass" });
  });

  // F7 / Q1f (flipped): an allow with no provenance (a stale gate's onTimeout / onHubUnreachable "allow") is no opinion,
  // so it no longer sets `effect: "allow"`; only a person's approval or a person's grant does.
  it("finds an installed gate under OPENCADRE_HOOK_HOME", async () => {
    const home = tmpDir("opencode-gate-home-");
    const bin = join(home, ".opencadre", "bin");
    mkdirSync(bin, { recursive: true });
    const gate = join(bin, "opencadre-approval-gate.mjs");
    writeFileSync(gate, 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));');
    const previous = process.env.OPENCADRE_HOOK_HOME;
    process.env.OPENCADRE_HOOK_HOME = home;
    try {
      expect(await runGate(gateArgs({ cwd: home }))).toEqual({ decision: "pass" });
      for (const provenance of ["person", "grant"]) {
        writeFileSync(gate, `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", opencadreProvenance: "${provenance}" } }));`);
        expect(await runGate(gateArgs({ cwd: home }))).toEqual({ decision: "allow" });
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCADRE_HOOK_HOME;
      else process.env.OPENCADRE_HOOK_HOME = previous;
    }
  });

  it.each([
    ["invalid JSON", 'process.stdout.write("{");'],
    ["invalid decision", 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }));'],
    ["nonzero exit", 'process.exit(7);'],
    ["too much output", 'process.stdout.write("x".repeat(70000));'],
  ])("denies when the helper returns %s", async (_name, source) => {
    const { cwd, gatePath } = script(source);
    expect((await runGate(gateArgs({ cwd, gatePath }))).decision).toBe("deny");
  });

  it("denies on helper timeout, missing process, empty command and input failure", async () => {
    const idle = script('setInterval(() => {}, 1000);');
    expect((await runGate(gateArgs({ ...idle, timeoutMs: 50 }))).decision).toBe("deny");
    expect((await runGate(gateArgs({ cwd: process.cwd(), nodePath: join(process.cwd(), "missing-node.exe"), gatePath: idle.gatePath }))).decision).toBe("deny");
    expect((await runGate(gateArgs({ cwd: process.cwd(), command: "" }))).decision).toBe("deny");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => { throw new Error("pipe closed"); };
    child.kill = () => queueMicrotask(() => child.emit("close", null));
    expect((await runGate(gateArgs({ cwd: process.cwd(), spawnImpl: () => child }))).decision).toBe("deny");
    const emitted = new EventEmitter();
    emitted.stdout = new EventEmitter();
    emitted.stderr = new EventEmitter();
    emitted.stdin = new EventEmitter();
    emitted.stdin.end = () => queueMicrotask(() => emitted.stdin.emit("error", new Error("pipe closed")));
    emitted.kill = () => queueMicrotask(() => emitted.emit("close", null));
    expect((await runGate(gateArgs({ cwd: process.cwd(), spawnImpl: () => emitted }))).decision).toBe("deny");
  });
});
