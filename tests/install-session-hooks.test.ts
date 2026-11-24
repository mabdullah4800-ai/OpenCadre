import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const INSTALLER = path.join(process.cwd(), "scripts", "install-session-hooks.mjs");
const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-awareness.mjs");
const WAKE = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");
const STAMP = path.join(process.cwd(), "examples", "hooks", "opencadre-session-stamp.mjs");
const USAGE = path.join(process.cwd(), "scripts", "opencadre-usage.mjs");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

type Handler = { type: string; command: string; timeout?: number; asyncRewake?: boolean; async?: boolean };
type Group = { matcher?: string; hooks: Handler[] };
type Hooks = Record<string, Group[]>;

function install(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], { env: { ...process.env, OPENCADRE_HOOK_HOME: home }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const tempHome = () => mkdtempSync(path.join(tmpdir(), "install-hooks-"));
const codexFile = (home: string) => path.join(home, ".codex", "hooks.json");
const claudeFile = (home: string) => path.join(home, ".claude", "settings.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const ours = (hooks: Hooks, event: string) =>
  (hooks[event] ?? []).flatMap((g) => g.hooks.filter((h) => h.command.includes("opencadre-awareness.mjs")).map((h) => ({ group: g, h })));

describe("install-session-hooks.mjs", () => {
  it("creates Codex hooks.json with every event pointing at this repo's hook", () => {
    const home = tempHome();
    const { code, out } = install(home, "--client", "codex");
    expect(code).toBe(0);
    const { hooks } = readJson(codexFile(home)) as { hooks: Hooks };
    for (const event of EVENTS) {
      const found = ours(hooks, event);
      expect(found).toHaveLength(1);
      expect(found[0].h).toEqual({ type: "command", command: `node "${HOOK}" --client codex`, timeout: 10 });
    }
    expect(ours(hooks, "SessionStart")[0].group.matcher).toBe("startup|resume|clear|compact");
    // The MCP alternation is the fix for our own calls being unobservable. BOTH forms are matched:
    // `mcp__opencadre_session__` is what our config table produces (hyphen normalised to underscore)
    // and `mcp__opencadre__` is the older namespace real installs used. Either alone is a filter that
    // installs cleanly and never fires on the machines using the other.
    expect(ours(hooks, "PostToolUse")[0].group.matcher).toBe("Edit|Write|Bash|exec_command|write_stdin|apply_patch|mcp__opencadre_session__.*|mcp__opencadre__.*");
    // Codex now has a gate in the execution path (PreToolUse) AND a recorder after it (PostToolUse).
    // They are different jobs: a refusal says what did not happen, a record says what did.
    expect(ours(hooks, "PostToolUse")[0].group.hooks[1]).toEqual({
      type: "command", command: `node "${path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs")}" --report --client codex`, timeout: 10,
    });
    expect(ours(hooks, "PostToolUse")[0].group.hooks[2].command).toContain("--typed-commit --client codex");
    // PreToolUse holds the GATE, not the awareness hook, so `ours()` (which filters on the awareness
    // marker) deliberately finds nothing there -- read the group directly.
    const pre = hooks.PreToolUse ?? [];
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe("Bash|exec_command|write_stdin|mcp__opencadre_session__.*|mcp__opencadre__.*");
    // The blocking invocation: `--report` would mean the command already ran.
    expect(pre[0].hooks[0].command).toContain("opencadre-approval-gate.mjs");
    expect(pre[0].hooks[0].command).not.toContain("--report");
    // The standalone installer carries the Codex identity stamp too (review of #531, d193): without it this
    // supported install path would never get per-chat identity.
    expect(pre[0].hooks[1]).toEqual({ type: "command", command: `node "${STAMP}"`, timeout: 10 });
    expect(out.trim().split("\n").at(-1)).toMatch(/\/hooks/);
  });

  it("is idempotent on a second run", () => {
    const home = tempHome();
    install(home, "--client", "codex");
    const first = readFileSync(codexFile(home), "utf8");
    expect(install(home, "--client", "codex").code).toBe(0);
    expect(readFileSync(codexFile(home), "utf8")).toBe(first);
    const { hooks } = readJson(codexFile(home)) as { hooks: Hooks };
    for (const event of EVENTS) expect(ours(hooks, event)).toHaveLength(1);
  });

  it("preserves unrelated hooks in order and backs up the original file", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-stop.mjs", timeout: 5 }] }] } }, null, 2);
    writeFileSync(codexFile(home), original);
    expect(install(home, "--client", "codex").code).toBe(0);

    const { hooks } = readJson(codexFile(home)) as { hooks: Hooks };
    expect(hooks.Stop[0]).toEqual({ hooks: [{ type: "command", command: "node other-stop.mjs", timeout: 5 }] });
    expect(ours(hooks, "Stop")).toHaveLength(1);

    const backups = readdirSync(path.join(home, ".codex")).filter((f) => f.startsWith("hooks.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(home, ".codex", backups[0]), "utf8")).toBe(original);
  });

  it("merges into Claude settings.json keeping other settings keys", () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(claudeFile(home), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node gate.mjs" }] }] } }));
    const { code, out } = install(home, "--client", "claude-code");
    expect(code).toBe(0);
    expect(out).not.toMatch(/\/hooks/);

    const settings = readJson(claudeFile(home));
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    // The user's own PreToolUse group is untouched; the OpenCadre clearance gate is added as its own group, on both of
    // Claude Code's shell tools (F8: Bash, and PowerShell on Windows).
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "node gate.mjs" }] });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[1]).toMatchObject({ matcher: "Bash|PowerShell", hooks: [{ type: "command", timeout: 600 }] });
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toMatch(/opencadre-approval-gate\.mjs" --client claude-code$/);
    for (const event of EVENTS) expect(ours(settings.hooks, event)).toHaveLength(1);
    expect(ours(settings.hooks, "PostToolUse")[0].group.matcher).toBe("Edit|Write|Bash");
    expect(JSON.stringify(settings.hooks.PostToolUse)).not.toContain("--report");
    expect(ours(settings.hooks, "SessionStart")[0].h.command).toBe(`node "${HOOK}" --client claude-code`);
    // Every OpenCadre handler stays in shell form, PostToolUse awareness included: a Claude Code that predates exec
    // form's `args` would run `command` alone, so an exec-form entry would break on older installs (049a, #723).
    for (const group of Object.values(settings.hooks as Hooks).flat()) {
      for (const h of group.hooks.filter((x) => x.command !== "node gate.mjs")) {
        expect(h).not.toHaveProperty("args");
        expect(h.command).toMatch(/^node "[^"]+" /);
      }
    }
    expect(ours(settings.hooks, "PostToolUse")[0].h.command).toBe(`node "${HOOK}" --client claude-code`);
  });

  it("--dry-run prints the merged JSON and writes nothing", () => {
    const home = tempHome();
    const { code, out } = install(home, "--client", "codex", "--dry-run");
    expect(code).toBe(0);
    expect(out).toContain("opencadre-awareness.mjs");
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("rejects an unknown client", () => {
    const { code, err } = install(tempHome(), "--client", "antigravity");
    expect(code).not.toBe(0);
    expect(err).toContain("--client codex|claude-code|cursor|gemini");
  });

  describe("idle wake (asyncRewake)", () => {
    const wakeHandlers = (hooks: Hooks) =>
      Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h.command.includes("opencadre-wake.mjs"))));

    it("adds the asyncRewake Stop handler for Claude Code, alongside the awareness Stop hook", () => {
      const home = tempHome();
      const { code, out } = install(home, "--client", "claude-code");
      expect(code).toBe(0);
      const { hooks } = readJson(claudeFile(home)) as { hooks: Hooks };
      expect(wakeHandlers(hooks)).toEqual([{ type: "command", command: `node "${WAKE}" --rewake --client claude-code`, asyncRewake: true, timeout: 604800 }]);
      const stop = ours(hooks, "Stop")[0].group;
      expect(stop.hooks.map((h) => h.command)).toEqual([`node "${HOOK}" --client claude-code`, `node "${WAKE}" --rewake --client claude-code`]);
      expect(out).toMatch(/asyncRewake/);
    });

    it("is idempotent and refreshes a moved checkout's path in place", () => {
      const home = tempHome();
      mkdirSync(path.join(home, ".claude"));
      const old = { type: "command", command: 'node "/old/checkout/scripts/opencadre-wake.mjs" --rewake --client claude-code', asyncRewake: true };
      writeFileSync(claudeFile(home), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-stop.mjs" }, old] }] } }));
      install(home, "--client", "claude-code");
      const first = readFileSync(claudeFile(home), "utf8");
      const { hooks } = JSON.parse(first) as { hooks: Hooks };
      expect(wakeHandlers(hooks)).toHaveLength(1);
      expect(hooks.Stop[0].hooks[1].command).toBe(`node "${WAKE}" --rewake --client claude-code`);

      expect(install(home, "--client", "claude-code").code).toBe(0);
      expect(readFileSync(claudeFile(home), "utf8")).toBe(first);
    });

    it("adds Codex's async Stop watcher alongside the stamp hook", () => {
      const home = tempHome();
      install(home, "--client", "codex");
      const { hooks } = readJson(codexFile(home)) as { hooks: Hooks };
      expect(wakeHandlers(hooks)).toEqual([{ type: "command", command: `node "${WAKE}" --codex-queue --client codex`, async: true, timeout: 604800 }]);
      expect(hooks.PreToolUse[0].hooks[1].command).toBe(`node "${STAMP}"`);
    });
  });
  describe("usage reporting", () => {
    const usageHandlers = (hooks: Hooks) =>
      Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h.command.includes("opencadre-usage.mjs"))));

    it("adds the usage reporter to Codex's Stop group, once", () => {
      const home = tempHome();
      install(home, "--client", "codex");
      const first = readFileSync(codexFile(home), "utf8");
      const { hooks } = JSON.parse(first) as { hooks: Hooks };
      expect(usageHandlers(hooks)).toEqual([{ type: "command", command: `node "${USAGE}" --client codex`, timeout: 10 }]);
      expect(ours(hooks, "Stop")[0].group.hooks.map((h) => h.command)).toEqual([`node "${HOOK}" --client codex`, `node "${USAGE}" --client codex`, `node "${WAKE}" --codex-queue --client codex`]);

      expect(install(home, "--client", "codex").code).toBe(0);
      expect(readFileSync(codexFile(home), "utf8")).toBe(first);
    });

    it("sets Claude Code's statusLine to the usage reporter when there is none", () => {
      const home = tempHome();
      const { code, out } = install(home, "--client", "claude-code");
      expect(code).toBe(0);
      const settings = readJson(claudeFile(home));
      expect(settings.statusLine).toEqual({ type: "command", command: `node "${USAGE}" --client claude-code --from-stdin` });
      expect(usageHandlers(settings.hooks)).toEqual([]);
      expect(out).toMatch(/status line/i);
    });

    it("never replaces a statusLine the user already has", () => {
      const home = tempHome();
      mkdirSync(path.join(home, ".claude"));
      const mine = { type: "command", command: "bash ~/.claude/my-statusline.sh", padding: 0 };
      writeFileSync(claudeFile(home), JSON.stringify({ statusLine: mine }));
      const { code, out } = install(home, "--client", "claude-code");
      expect(code).toBe(0);
      expect(readJson(claudeFile(home)).statusLine).toEqual(mine);
      expect(out).toMatch(/status line/i);
      expect(out).toContain("opencadre-usage.mjs");
    });
  });
});
