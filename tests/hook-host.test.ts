// Which harness ran a Claude-format hook. VS Code's agent (Copilot Chat, `chat.useClaudeHooks`) runs Claude Code's hooks
// with a payload of its own (microsoft/vscode 51e35ae, chatHookService.ts: an ISO `timestamp`, no `permission_mode`)
// and the extension host's environment (no CLAUDE_PROJECT_DIR). A Claude Code hook there stands down; every other
// client's own hook, whose payload may look the same (Gemini CLI, Qwen Code), does not.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { foreignHost, hookHost, waitCapFor } from "../scripts/opencadre-hook-dialect.mjs";

const saved: Record<string, string | undefined> = {};
const KEYS = ["CLAUDE_PROJECT_DIR", "COPILOT_CLI", "COPILOT_PROJECT_DIR", "DEVIN_PROJECT_DIR"];
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const vscode = { timestamp: "2026-09-24T07:00:00.000Z", hook_event_name: "PreToolUse", session_id: "vs-1", tool_name: "run_in_terminal", tool_input: { command: "ls" }, cwd: "/w" };
const claude = { session_id: "c-1", transcript_path: "/t", cwd: "/w", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

describe("hookHost: VS Code's agent running Claude-format hooks", () => {
  it("is recognised by its timestamp, no permission_mode, and no CLAUDE_PROJECT_DIR", () => {
    expect(hookHost(vscode)).toBe("vscode");
    expect(foreignHost("claude-code", vscode)).toBe("vscode");
  });

  it("is never real Claude Code: permission_mode, or CLAUDE_PROJECT_DIR, rules it out", () => {
    expect(hookHost(claude)).toBeNull();
    expect(hookHost({ ...claude, timestamp: "x" })).toBeNull();
    process.env.CLAUDE_PROJECT_DIR = "/w";
    expect(hookHost(vscode)).toBeNull();
  });

  it("never makes another client's own hook stand down (Gemini CLI's payload has the same shape)", () => {
    expect(foreignHost("gemini", vscode)).toBeNull();
    expect(foreignHost("qwen", vscode)).toBeNull();
  });

  it("Copilot CLI still wins where its hook environment says so", () => {
    process.env.COPILOT_CLI = "1";
    process.env.COPILOT_PROJECT_DIR = "/w";
    expect(hookHost(vscode)).toBe("copilot");
  });
});

describe("hookHost: Grok Build and Devin CLI running Claude Code's hooks (both load ~/.claude/settings.json)", () => {
  // Measured: Grok 1.0.41 sends every key in both styles; Devin 3000.6.11 sends neither cwd nor transcript_path and sets
  // DEVIN_PROJECT_DIR (and CLAUDE_PROJECT_DIR) for hooks only.
  const grok = { ...claude, hookEventName: "pre_tool_use", sessionId: "g-1", workspaceRoot: "/w", timestamp: "t", permissionMode: "default" };
  const devin = { hook_event_name: "PreToolUse", session_id: "beautiful-dugout", prompt_id: "p", tool_name: "exec", tool_input: { command: "ls" } };

  it("recognises Grok by the camelCase keys Claude Code never sends, even with CLAUDE_PROJECT_DIR set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/w";
    expect(hookHost(grok)).toBe("grok");
    expect(foreignHost("claude-code", grok)).toBe("grok");
    expect(foreignHost("grok", grok)).toBeNull();
  });

  it("recognises Devin by its missing cwd and transcript_path plus DEVIN_PROJECT_DIR, and never real Claude Code", () => {
    process.env.CLAUDE_PROJECT_DIR = "/w";
    expect(hookHost(devin)).toBeNull();
    process.env.DEVIN_PROJECT_DIR = "/w";
    expect(hookHost(devin)).toBe("devin");
    expect(foreignHost("claude-code", devin)).toBe("devin");
    // Real Claude Code always sends cwd and transcript_path (prompt_id too, since 2.1.42).
    expect(hookHost({ ...claude, prompt_id: "p" })).toBeNull();
  });

  it("neither is ever a foreign host for another client's own hook, except Grok for Cursor's (Grok loads those too)", () => {
    process.env.DEVIN_PROJECT_DIR = "/w";
    expect(foreignHost("gemini", grok)).toBeNull();
    expect(foreignHost("qwen", devin)).toBeNull();
    // Review of 7ffc12c, N1: Grok runs ~/.cursor/hooks.json by default.
    expect(foreignHost("cursor", grok)).toBe("grok");
    expect(foreignHost("cursor", devin)).toBeNull();
  });
});

describe("waitCapFor: a harness that runs the call when its hook times out keeps the gate's wait inside that timeout", () => {
  it("caps every hook harness inside the timeout connect gives its gate, and no in-process plugin", () => {
    // Reviews of 3f5e2a1 (Copilot) and 7ffc12c (Grok, B2); Cline kills at 120 s; Devin's timeout lets the call run.
    expect(waitCapFor("copilot")).toBe(540);
    expect(waitCapFor("grok")).toBe(540);
    expect(waitCapFor("devin")).toBe(540);
    expect(waitCapFor("cline")).toBe(100);
    // Gemini CLI 0.61.0 and Qwen Code 0.24.4 were measured to run the call when the gate's hook timed out; every other
    // hook harness is capped the same way, since the cap only replaces a kill with the gate's own answer.
    for (const client of ["gemini", "qwen", "claude-code", "codex", "cursor", "antigravity", "goose", "windsurf"]) expect(waitCapFor(client), client).toBe(540);
    // An in-process plugin's gate is awaited with no timeout.
    expect(waitCapFor("kilo")).toBe(Infinity);
    expect(waitCapFor("amp")).toBe(Infinity);
  });
});

describe("typedShellInput: keystrokes typed into a running shell", () => {
  it("reads Devin's key names in any case, and Copilot's write_bash input, with the shell they go to", async () => {
    const { typedShellInput } = await import("../scripts/opencadre-hook-dialect.mjs");
    const devin = (t: object) => typedShellInput({ tool_name: "write_to_process", tool_input: { shell_id: "s9", ...t } });
    const plain = { edits: false, interrupt: false };
    expect(devin({ bytes_input: "rm<TAB>-rf<Tab>x<CR>a<cr>b<C-m>c<LF>d<c-J>e<c-i>" })).toEqual({ shell: "s9", text: "rm\t-rf\tx\na\nb\nc\nd\ne\t", ...plain });
    expect(devin({ text_input: "a\r\nb\rc<CR>" })).toEqual({ shell: "s9", text: "a\nb\nc<CR>", ...plain });
    expect(devin({})).toEqual({ shell: "s9", text: undefined, ...plain });
    expect(typedShellInput({ toolName: "write_bash", toolArgs: JSON.stringify({ shellId: "b1", input: "rm -rf x\r" }) })).toEqual({ shell: "b1", text: "rm -rf x\n", ...plain });
    // Keys and bytes that edit the line; an interrupt alone (review of 8fe0ca9, B2).
    for (const keys of ["a<BS>", "<C-a>r", "<c-u>", "<LEFT>", "<home>", "<ESC>", "<C-w>"]) expect(devin({ bytes_input: keys }).edits, keys).toBe(true);
    expect(devin({ text_input: "rmx\b -rf" }).edits).toBe(true);
    expect(typedShellInput({ toolName: "write_bash", toolArgs: { input: "\x1b[D" } })?.edits).toBe(true);
    expect(typedShellInput({ toolName: "write_bash", toolArgs: { shellId: "b1", input: "\x04" } })).toMatchObject({ interrupt: false, edits: true });
    expect(typedShellInput({ toolName: "write_powershell", toolArgs: { shellId: "p1", input: "\x04" } })).toMatchObject({ interrupt: false, edits: true });
    expect(typedShellInput({ toolName: "write_bash", toolArgs: { shellId: "b1", input: "\x03" } })).toMatchObject({ interrupt: true, edits: false });
    expect(devin({ bytes_input: "<C-c>" })).toMatchObject({ interrupt: true, edits: false });
    expect(devin({ bytes_input: "<C-c>rm" })).toMatchObject({ interrupt: false, edits: true });
    expect(typedShellInput({ tool_name: "exec", tool_input: { command: "ls" } })).toBeNull();
  });
});

describe("host handoff ancestry", () => {
  it.skipIf(process.platform !== "win32")("rejects a live but unrelated proxy pid on Windows", async () => {
    const { readHostHandoff } = await import("../scripts/opencadre-config.mjs");
    const home = mkdtempSync(path.join(tmpdir(), "oc-handoff-ancestry-"));
    const run = path.join(home, ".opencadre", "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, `qwen-${process.pid}.json`), JSON.stringify({ client: "qwen", hostPid: process.pid, proxyPid: process.ppid, mode: "pooled" }));
    expect(readHostHandoff({ client: "qwen", hostPid: process.pid, home, platform: "win32" })).toBeNull();
  });
});

describe("host handoff command line injection", () => {
  it.skipIf(process.platform !== "win32")("rejects forged parent rows embedded in a sibling process argument", async () => {
    const { spawn } = await import("node:child_process");
    const { rmSync } = await import("node:fs");
    const { readHostHandoff } = await import("../scripts/opencadre-config.mjs");
    const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const proxy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "\n99999\t" + host.pid + "\tforged"], { stdio: "ignore" });
    let home: string | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(host.exitCode).toBeNull();
      expect(proxy.exitCode).toBeNull();
      home = mkdtempSync(path.join(tmpdir(), "oc-handoff-forged-row-"));
      const run = path.join(home, ".opencadre", "run");
      mkdirSync(run, { recursive: true });
      writeFileSync(path.join(run, "qwen-" + host.pid + ".json"), JSON.stringify({ client: "qwen", hostPid: host.pid, proxyPid: proxy.pid, mode: "pooled" }));
      expect(readHostHandoff({ client: "qwen", hostPid: host.pid, home, platform: "win32" })).toBeNull();
    } finally {
      host.kill();
      proxy.kill();
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });
});
