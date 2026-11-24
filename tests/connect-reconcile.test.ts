// PR-B (premise plan §3.C): `connect --upgrade` brings every ALREADY-connected client's OpenCadre-owned config current,
// not only the helper files.
//
// THE MEASURED DEFECT (operator's PC, 2026-10-01): after `connect --upgrade` the helpers were current, but doctor said
// `verdict=gate_outdated gate_matcher=outdated`: F8 (#676) moved Claude Code's PreToolUse matcher from "Bash" to
// "Bash|PowerShell", and --upgrade never touched client config, so the fix needed a second, different command.
//
// The pre-F8 settings.json below is the OUTPUT OF THE PRE-#676 WRITER, taken from git history
// (`git show d7ee636b^:cli/lib/session-hooks.mjs`, run for an isolated home), with the bin path as <BIN>.
//
// Each test names the world in which it fails; the mutants are listed in the PR-B report.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { isDroppedFromChild, isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";
import { planCodexSessionServer, planSessionServer } from "../cli/lib/device.mjs";
import { applyReconcile, planReconcile } from "../cli/lib/reconcile.mjs";
import { runDoctor } from "../cli/lib/doctor.mjs";

vi.setConfig({ testTimeout: 90_000 });
// The writers resolve Codex's folder through CODEX_HOME; a value inherited from the machine would point them at a real
// ~/.codex. Every Codex path in this file is the isolated home's.
delete process.env.CODEX_HOME;

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");

// The child reads ONLY the test home: every home/client override is dropped from the parent case-insensitively, then set
// explicitly (tests/helpers/isolated-cli-env.ts). `parent` is a parameter so the control below can hand it a decoy.
const runCli = (args: string[], home: string, parent: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: isolatedCliEnv(home, parent) });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
// --verbose: these tests read the FULL report (per file, per hook, trust notes). The short default form is asserted in
// its own describe below, on the same worlds.
const upgrade = (home: string, ...extra: string[]) => runCli(["connect", "--upgrade", "--offline", "--verbose", "--home", home, ...extra], home);
const upgradeShort = (home: string) => runCli(["connect", "--upgrade", "--offline", "--home", home], home);

const binOf = (home: string) => path.join(home, ".opencadre", "bin");
const hookPaths = (bin: string) => ({
  awarenessPath: path.join(bin, "opencadre-awareness.mjs"), wakePath: path.join(bin, "opencadre-wake.mjs"), usagePath: path.join(bin, "opencadre-usage.mjs"),
  gatePath: path.join(bin, "opencadre-approval-gate.mjs"), stampPath: path.join(bin, "opencadre-session-stamp.mjs"),
});
const backupsOf = (file: string) => (existsSync(path.dirname(file)) ? readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-`)) : []);

/** settings.json exactly as the pre-F8 writer produced it (git history, d7ee636b^), plus a user's own hook and setting. */
const PRE_F8_CLAUDE = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-awareness.mjs\\" --client claude-code",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-awareness.mjs\\" --client claude-code",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-awareness.mjs\\" --client claude-code",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-awareness.mjs\\" --client claude-code",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-wake.mjs\\" --rewake --client claude-code",
            "asyncRewake": true,
            "timeout": 604800
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"<BIN>/opencadre-approval-gate.mjs\\" --client claude-code",
            "timeout": 600
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node my-own-linter.mjs"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "node \\"<BIN>/opencadre-usage.mjs\\" --client claude-code --from-stdin"
  },
  "theme": "dark"
}
`;
const USER_GROUP = `      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node my-own-linter.mjs"
          }
        ]
      }`;

/** A home connected for Claude Code by the computer path, with the pre-F8 hooks. Returns the two config files. */
function connectedClaudePreF8(home: string) {
  const bin = binOf(home);
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  // The path exactly as the writer joined it (backslashes on Windows), escaped for the JSON string it sits in.
  writeFileSync(settings, PRE_F8_CLAUDE.replaceAll("<BIN>/", JSON.stringify(bin + path.sep).slice(1, -1)));
  const claudeJson = path.join(home, ".claude.json");
  const server = planSessionServer({ home, proxyPath: path.join(bin, "opencadre-mcp.mjs"), client: "claude-code" });
  const withOther = JSON.parse(server.after);
  withOther.mcpServers["my-own-server"] = { type: "stdio", command: "my-server" };
  writeFileSync(claudeJson, `${JSON.stringify(withOther, null, 2)}\n`);
  return { settings, claudeJson };
}

/** A home connected for Codex by the CURRENT writers (server table + hooks.json). */
function connectedCodexCurrent(home: string) {
  const bin = binOf(home);
  const server = planCodexSessionServer({ home, proxyPath: path.join(bin, "opencadre-mcp.mjs") });
  mkdirSync(path.dirname(server.file), { recursive: true });
  writeFileSync(server.file, `[mcp_servers.my-own]\ncommand = "x"\n\n${server.after}`);
  const hooks = planSessionHooks({ home, client: "codex", ...hookPaths(bin) });
  writeFileSync(hooks.file, hooks.after);
  return { config: server.file, hooksFile: hooks.file };
}

const stubFetch = (manifest: unknown) => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/cli/manifest.json") && manifest) return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not here", { status: 404 });
  });
};
afterEach(() => vi.unstubAllGlobals());

describe("connect --upgrade reconciles Claude Code's OpenCadre-owned config (the F8 PowerShell matcher)", () => {
  it("moves the pre-F8 gate matcher to Bash|PowerShell, keeps the user's own hook byte-identical, backs up, and doctor stops saying gate_outdated", async () => {
    const home = tmpDir("oc-reconcile-cc-");
    const { settings, claudeJson } = connectedClaudePreF8(home);
    const before = readFileSync(settings, "utf8");
    const claudeJsonBefore = readFileSync(claudeJson, "utf8");
    stubFetch(null);
    const pre = await runDoctor({ client: "claude-code", home });
    expect(pre.lines.join("\n")).toMatch(/gate_matcher=outdated/);

    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(0);
    const after = readFileSync(settings, "utf8");
    const parsed = JSON.parse(after);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell");
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toMatch(/opencadre-approval-gate\.mjs" --client claude-code$/);
    // The user's own group: same position, same bytes (2-space JSON in, 2-space JSON out), and still Bash-only.
    expect(after).toContain(USER_GROUP);
    expect(parsed.hooks.PreToolUse[1]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "node my-own-linter.mjs" }] });
    expect(parsed.theme).toBe("dark");
    // Exactly one change in the file: the matcher line.
    expect(after).toBe(before.replace('"matcher": "Bash",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "node \\"', '"matcher": "Bash|PowerShell",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "node \\"'));
    // A durable copy of the exact previous bytes.
    const baks = backupsOf(settings);
    expect(baks).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(settings), baks[0]), "utf8")).toBe(before);
    // The server entry was already current: not rewritten, no backup.
    expect(readFileSync(claudeJson, "utf8")).toBe(claudeJsonBefore);
    expect(backupsOf(claudeJson)).toEqual([]);
    // Said, per file, with its trust class: matcher-only, and Claude Code keeps no per-hook trust record.
    expect(r.out).toContain(`${settings}: changed (previous version kept as`);
    expect(r.out).toContain('PreToolUse approval gate: matcher "Bash" -> "Bash|PowerShell"');
    expect(r.out).toMatch(/trust: matcher\/field-only; Claude Code keeps no per-hook trust record/);
    expect(r.out).toContain(`${claudeJson}: unchanged (already current)`);
    expect(r.out).not.toMatch(/TO DO/);
    expect(r.out).toContain("Nothing for you to do.");
    expect(r.out).not.toContain("What you need to do:");

    const post = await runDoctor({ client: "claude-code", home });
    expect(post.lines.join("\n")).not.toMatch(/gate_matcher=|does not cover/);
  });

  it("is idempotent: a second run rewrites nothing and makes no backup", async () => {
    const home = tmpDir("oc-reconcile-cc2-");
    const { settings, claudeJson } = connectedClaudePreF8(home);
    expect((await upgrade(home)).code).toBe(0);
    const bytes = readFileSync(settings, "utf8");
    const mtime = statSync(settings).mtimeMs;
    const baks = backupsOf(settings);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(bytes);
    expect(statSync(settings).mtimeMs).toBe(mtime);
    expect(backupsOf(settings)).toEqual(baks);
    expect(backupsOf(claudeJson)).toEqual([]);
    expect(r.out).toContain(`${settings}: unchanged (already current)`);
  });

  it("--dry-run lists the entries that would change, per client, and writes nothing", async () => {
    const home = tmpDir("oc-reconcile-dry-");
    const { settings, claudeJson } = connectedClaudePreF8(home);
    const before = readFileSync(settings, "utf8");
    const r = await upgrade(home, "--dry-run");
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("Dry run: nothing was written.");
    expect(r.out).toMatch(/Client config that would be brought current/);
    expect(r.out).toContain("  Claude Code");
    expect(r.out).toContain(`${settings}: would change`);
    expect(r.out).toContain('PreToolUse approval gate: matcher "Bash" -> "Bash|PowerShell"');
    expect(r.out).toContain(`${claudeJson}: unchanged (already current)`);
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(backupsOf(settings)).toEqual([]);
    expect(existsSync(binOf(home))).toBe(false);
  });

  it("never adds a handler the file lacks (it may have been removed on purpose): reported with the command that adds it", async () => {
    const home = tmpDir("oc-reconcile-missing-");
    const { settings } = connectedClaudePreF8(home);
    const config = JSON.parse(readFileSync(settings, "utf8"));
    config.hooks.Stop[0].hooks = config.hooks.Stop[0].hooks.filter((h: { command: string }) => !h.command.includes("opencadre-wake.mjs"));
    writeFileSync(settings, `${JSON.stringify(config, null, 2)}\n`);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell");
    expect(JSON.stringify(after.hooks.Stop)).not.toContain("opencadre-wake.mjs");
    expect(r.out).toMatch(/TO DO: Not added, because it may have been removed on purpose: Stop idle wake\. Run `connect` to add it\./);
    expect(r.out).toContain("What you need to do:");
  });

  it("leaves hooks that run another install's helpers (a repo checkout) alone, and says so", async () => {
    const home = tmpDir("oc-reconcile-elsewhere-");
    const settings = path.join(home, ".claude", "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const text = PRE_F8_CLAUDE.replaceAll("<BIN>", "C:/checkout/OpenCadre/examples/hooks");
    writeFileSync(settings, text);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(readFileSync(settings, "utf8")).toBe(text);
    expect(backupsOf(settings)).toEqual([]);
    expect(r.out).toMatch(/run helpers from C:\/checkout\/OpenCadre\/examples\/hooks, not this install/);
  });
});

describe("connect --upgrade never connects a client the user did not connect", () => {
  it("a tool with no OpenCadre entries is read at most, never written", async () => {
    const home = tmpDir("oc-reconcile-none-");
    const settings = path.join(home, ".claude", "settings.json");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    const codexHooks = path.join(home, ".codex", "hooks.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    mkdirSync(path.dirname(cursorMcp), { recursive: true });
    mkdirSync(path.dirname(codexHooks), { recursive: true });
    const files = {
      [settings]: `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node my-own-linter.mjs" }] }] } }, null, 2)}\n`,
      [cursorMcp]: `${JSON.stringify({ mcpServers: { mine: { command: "x" } } }, null, 2)}\n`,
      [codexHooks]: `${JSON.stringify({ hooks: {} }, null, 2)}\n`,
      [path.join(home, ".claude.json")]: `${JSON.stringify({ mcpServers: { mine: { command: "x" } } }, null, 2)}\n`,
    };
    for (const [f, t] of Object.entries(files)) writeFileSync(f, t);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(0);
    for (const [f, t] of Object.entries(files)) {
      expect(readFileSync(f, "utf8")).toBe(t);
      expect(backupsOf(f)).toEqual([]);
    }
    expect(existsSync(path.join(home, ".cursor", "hooks.json"))).toBe(false);
    expect(r.out).toContain("no tool on this computer has OpenCadre connected, so no client config was read or changed");
  });
});

describe("connect --upgrade and Codex: positions and hashed fields are Codex's trust", () => {
  it("a current Codex install is left byte-identical: no rewrite, no backup, nothing owed", async () => {
    const home = tmpDir("oc-reconcile-codex-ok-");
    const { config, hooksFile } = connectedCodexCurrent(home);
    const bytes = { config: readFileSync(config, "utf8"), hooks: readFileSync(hooksFile, "utf8") };
    const mtimes = { config: statSync(config).mtimeMs, hooks: statSync(hooksFile).mtimeMs };
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(bytes.config);
    expect(readFileSync(hooksFile, "utf8")).toBe(bytes.hooks);
    expect(statSync(config).mtimeMs).toBe(mtimes.config);
    expect(statSync(hooksFile).mtimeMs).toBe(mtimes.hooks);
    expect(backupsOf(config)).toEqual([]);
    expect(backupsOf(hooksFile)).toEqual([]);
    expect(r.out).toContain("  Codex");
    expect(r.out).not.toMatch(/TO DO/);
  });

  it("a MATCHER-only change on a hashed Codex event is applied in place and names every hook Codex may list for review", async () => {
    const home = tmpDir("oc-reconcile-codex-m-");
    const { hooksFile } = connectedCodexCurrent(home);
    const config = JSON.parse(readFileSync(hooksFile, "utf8"));
    const current = config.hooks.PostToolUse[0].matcher;
    config.hooks.PostToolUse[0].matcher = "Edit|Write|Bash|apply_patch"; // an older Codex matcher (tests/codex-hooks-mcp-matcher)
    writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    const after = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(after.hooks.PostToolUse[0].matcher).toBe(current);
    expect(after.hooks.PostToolUse[0].hooks).toEqual(config.hooks.PostToolUse[0].hooks); // positions and handlers untouched
    expect(r.out).toMatch(/matcher\/field-only/);
    // A review to check, never a certainty (review of #692 at f640bf73): OpenCadre does not compute Codex's hash.
    expect(r.out).toMatch(/TO DO: Codex may list these OpenCadre hooks as changed and ask you to review them, because a setting it hashes changed: PostToolUse awareness, PostToolUse command record, PostToolUse typed-commit record\. Review status unverified/);
    expect(r.out).not.toMatch(/will skip|until you trust them again|stale/i);
  });

  it("a COMMAND change is applied and reported as command-changing, with the review-status action", async () => {
    const home = tmpDir("oc-reconcile-codex-c-");
    const { hooksFile } = connectedCodexCurrent(home);
    const config = JSON.parse(readFileSync(hooksFile, "utf8"));
    const want = config.hooks.UserPromptSubmit[0].hooks[0].command;
    config.hooks.UserPromptSubmit[0].hooks[0].command = want.replace(" --client codex", "");
    writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(JSON.parse(readFileSync(hooksFile, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command).toBe(want);
    expect(r.out).toMatch(/UserPromptSubmit awareness: command changed/);
    expect(r.out).toMatch(/Codex hashes this hook's settings, so it may list 1 for review \(command-changing; review status unverified\)/);
    expect(r.out).toMatch(/TO DO: Codex may list these OpenCadre hooks as changed and ask you to review them, because a setting it hashes changed: UserPromptSubmit awareness\. Review status unverified/);
  });

  it("a hook the user turned OFF in Codex (hooks.state enabled = false) is not touched, and is reported", async () => {
    const home = tmpDir("oc-reconcile-codex-off-");
    const { config, hooksFile } = connectedCodexCurrent(home);
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    hooks.hooks.PostToolUse[0].matcher = "Edit|Write|Bash|apply_patch";
    writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    writeFileSync(config, `${readFileSync(config, "utf8")}\n[hooks.state.'${hooksFile}:post_tool_use:0:0']\nenabled = false\n`);
    const before = readFileSync(hooksFile, "utf8");
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(readFileSync(hooksFile, "utf8")).toBe(before);
    expect(backupsOf(hooksFile)).toEqual([]);
    expect(r.out).toMatch(/You turned off PostToolUse awareness in Codex/);
  });

  it("a change that would MOVE a Codex hook to a new position is not applied (trust and enabled are keyed by position)", async () => {
    const home = tmpDir("oc-reconcile-codex-pos-");
    const { hooksFile } = connectedCodexCurrent(home);
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    // A user's own handler inside OUR PreToolUse group, with an older matcher: the writer would split the group.
    hooks.hooks.PreToolUse[0].matcher = "Bash";
    hooks.hooks.PreToolUse[0].hooks.splice(1, 0, { type: "command", command: "node my-own-check.mjs" });
    writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    const before = readFileSync(hooksFile, "utf8");
    const r = await upgrade(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(readFileSync(hooksFile, "utf8")).toBe(before);
    expect(backupsOf(hooksFile)).toEqual([]);
    expect(r.out).toMatch(/would move hooks to new positions, and Codex keeps each hook's trust and on\/off setting by position/);
  });
});

describe("snapshot -> plan -> apply -> revalidate: a concurrent change is never overwritten", () => {
  const preparedHome = () => {
    const home = tmpDir("oc-reconcile-race-");
    const { settings } = connectedClaudePreF8(home);
    mkdirSync(binOf(home), { recursive: true });
    return { home, settings };
  };
  const addKey = (file: string, key: string) => {
    const c = JSON.parse(readFileSync(file, "utf8"));
    c[key] = true;
    writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  };

  it("a change between plan and apply makes it re-plan from the new bytes: the other writer's change survives", () => {
    const { home, settings } = preparedHome();
    let fired = 0;
    const result = applyReconcile({ home, onStep: (step: string, info: { file: string }) => {
      if (step === "planned" && info.file === settings && fired++ === 0) addKey(settings, "concurrentEdit");
    } });
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.concurrentEdit).toBe(true);
    expect(after.hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell");
    const part = result.clients.find((c: { client: string }) => c.client === "claude-code")!.parts.find((p: { file: string }) => p.file === settings)!;
    expect(part.status).toBe("applied");
    // The backup is of the bytes the applied plan was made from: the other writer's version.
    expect(JSON.parse(readFileSync(part.backup, "utf8")).concurrentEdit).toBe(true);
  });

  it("a file that keeps changing is left exactly as the other writer left it, and reported blocked", () => {
    const { home, settings } = preparedHome();
    let n = 0;
    const result = applyReconcile({ home, onStep: (step: string, info: { file: string }) => {
      if (step === "planned" && info.file === settings) addKey(settings, `edit${n++}`);
    } });
    const after = readFileSync(settings, "utf8");
    expect(JSON.parse(after).hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(JSON.parse(after).edit1).toBe(true);
    expect(backupsOf(settings)).toEqual([]);
    const part = result.clients.find((c: { client: string }) => c.client === "claude-code")!.parts.find((p: { file: string }) => p.file === settings)!;
    expect(part.status).toBe("blocked");
    expect(part.notes.join(" ")).toMatch(/left exactly as the other program wrote it/);
  });

  it("refuses to run while another installer holds the lock: nothing is planned into a file", () => {
    const { home, settings } = preparedHome();
    const before = readFileSync(settings, "utf8");
    writeFileSync(path.join(binOf(home), ".opencadre-install-acquire.lock"), "");
    expect(() => applyReconcile({ home })).toThrow(/Another installer/);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  it("the dry-run plan and the applied result name the same file and change", () => {
    const { home, settings } = preparedHome();
    const planned = planReconcile({ home }).clients.find((c: { client: string }) => c.client === "claude-code")!.parts.find((p: { file: string }) => p.file === settings)!;
    expect(planned.status).toBe("apply");
    const applied = applyReconcile({ home }).clients.find((c: { client: string }) => c.client === "claude-code")!.parts.find((p: { file: string }) => p.file === settings)!;
    expect(applied.changes.map((c: { text: string }) => c.text)).toEqual(planned.changes.map((c: { text: string }) => c.text));
  });
});

describe("doctor's gate_outdated advice is ONE stamped command", () => {
  const stamp = "0123456789ab";
  const manifest = (hub: string) => ({ tarball: { stamp, sha256: `${stamp}${"c".repeat(52)}`, bytes: 4096, url: `${hub}/cli/${stamp}/opencadre-cli.tgz` }, command: `npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade` });

  it("prints the hub's stamped connect --upgrade, not 'run the connect command again'", async () => {
    const home = tmpDir("oc-reconcile-doctor-");
    connectedClaudePreF8(home);
    stubFetch(manifest("https://hub.opencadre.example"));
    const r = await runDoctor({ client: "claude-code", home });
    const text = r.lines.join("\n");
    expect(text).toMatch(/gate_matcher=outdated/);
    expect(text).toContain(`run \`npx -y https://hub.opencadre.example/cli/${stamp}/opencadre-cli.tgz connect --upgrade\` (it brings the helpers and this matcher current)`);
    expect(text).not.toMatch(/does not cover[^\n]*run the connect command again/);
    expect(r.healthy).toBe(false);
  });

  it("with no verifiable manifest it prints no command at all (never a bare URL)", async () => {
    const home = tmpDir("oc-reconcile-doctor2-");
    connectedClaudePreF8(home);
    stubFetch(null);
    const text = (await runDoctor({ client: "claude-code", home })).lines.join("\n");
    expect(text).toMatch(/could not be verified \(HTTP 404\), so no command is printed/);
    expect(text).not.toMatch(/\/cli\/opencadre-cli\.tgz/);
  });
});

// Review of #692 at 02c4f838 (Codex-049a; Olive measured four exit-3 mismatches from an inherited real %APPDATA%): the
// child must read ONLY its test home even when the PARENT environment points every client resolver somewhere else.
describe("test isolation: a decoy parent environment never reaches the CLI child", () => {
  /** A home where several tools look connected, at the places APPDATA / XDG_CONFIG_HOME / CODEX_HOME / HOME resolve to. */
  function decoyHome() {
    const home = tmpDir("oc-reconcile-decoy-");
    const proxy = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
    const session = { command: "node", args: [proxy, "--client", "x"] };
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    // Devin uses APPDATA on Windows and XDG_CONFIG_HOME on other platforms.
    const devinDir = process.platform === "win32" ? path.join(home, "AppData", "Roaming", "devin") : path.join(home, ".config", "devin");
    write(path.join(devinDir, "mcp_config.json"), `${JSON.stringify({ mcpServers: { "opencadre-session": session } }, null, 2)}\n`);
    write(path.join(home, ".config", "amp", "settings.json"), `${JSON.stringify({ "amp.mcpServers": { "opencadre-session": session } }, null, 2)}\n`);
    write(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = [${JSON.stringify(proxy)}, "--client", "codex"]\n`);
    write(path.join(home, ".claude.json"), `${JSON.stringify({ mcpServers: { "opencadre-session": { type: "stdio", ...session } } }, null, 2)}\n`);
    const parent: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home, USERPROFILE: home, Home: home,
      APPDATA: path.join(home, "AppData", "Roaming"), AppData: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
      CODEX_HOME: path.join(home, ".codex"), codex_home: path.join(home, ".codex"),
    };
    return { home, parent };
  }
  const snapshotDir = (dir: string): Record<string, string> => Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
      const p = path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name);
      return [p, readFileSync(p, "utf8")];
    }));

  it("known positive: pointed AT the decoy home, the CLI does find its tools (so the control below can fail)", async () => {
    const decoy = decoyHome();
    const r = await runCli(["connect", "--upgrade", "--offline", "--dry-run", "--home", decoy.home], decoy.home, decoy.parent);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("  Claude Code");
    expect(r.out).toContain("  Codex");
    expect(r.out).toContain("  Devin");
  });

  it("control: with a conflicting parent (decoy HOME, APPDATA/AppData, XDG, CODEX_HOME), the child reads ONLY its test home", async () => {
    const decoy = decoyHome();
    const before = snapshotDir(decoy.home);
    const home = tmpDir("oc-reconcile-isolated-");
    const r = await runCli(["connect", "--upgrade", "--offline", "--dry-run", "--home", home], home, decoy.parent);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("no tool on this computer has OpenCadre connected, so no client config was read or changed");
    expect(r.out + r.err).not.toContain(decoy.home);
    expect(snapshotDir(decoy.home)).toEqual(before);
  });

  it("the env builder drops every home/client override case-insensitively and sets the test home's own values last", () => {
    const home = path.join("Z:", "test-home");
    const env = isolatedCliEnv(home, { Path: "C:/real", AppData: "C:/real/AppData", HOME: "C:/real", codex_home: "C:/real/.codex", Xdg_Config_Home: "C:/real/.config", Opencadre_Hub: "x", SystemRoot: "C:/Windows", TEMP: "C:/tmp" });
    const keys = Object.keys(env).map((k) => k.toUpperCase());
    expect(new Set(keys).size).toBe(keys.length); // no case-variant duplicates
    expect(Object.keys(env).filter((k) => isDroppedFromChild(k)).sort()).toEqual(["APPDATA", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "LOCALAPPDATA", "PATH", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
    expect(env.HOME).toBe(home);
    expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
    expect(env.PATH).toBe("");
    expect(env.SystemRoot).toBe("C:/Windows"); // OS and runtime variables are kept
    expect(env.TEMP).toBe("C:/tmp");
    expect(Object.values(env).join("|")).not.toContain("C:/real");
  });
});

// The SHORT report (2026-10-02, operator: "it's quite long"). By default `connect --upgrade` prints one result line, a
// numbered "What you need to do" list only when something is owed, one line about backups, and where the full report is.
// The full report (above) is printed with --verbose and saved to ~/.opencadre/last-upgrade.txt on every run.
// What may NEVER drop out of the short form: a hook a tool may want approved again, a refused or blocked state, an
// error, and the fact that backups exist. Each test below fails if one of those is moved behind --verbose.
describe("connect --upgrade prints a short report by default", () => {
  /** The operator's world of 2026-10-02: Claude Code on the pre-F8 matcher, and a Codex whose PostToolUse matcher is older
   * and whose typed-commit record was removed (so it may have been removed on purpose, and is not added back). */
  const operatorWorld = (home: string) => {
    const claude = connectedClaudePreF8(home);
    const { hooksFile } = connectedCodexCurrent(home);
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    hooks.hooks.PostToolUse[0].matcher = "Edit|Write|Bash|apply_patch";
    hooks.hooks.PostToolUse[0].hooks = hooks.hooks.PostToolUse[0].hooks.filter((h: { command: string }) => !h.command.includes("--typed-commit"));
    writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
    return { ...claude, hooksFile };
  };
  const reportOf = (home: string) => path.join(home, ".opencadre", "last-upgrade.txt");

  it("with something to do: one result line, a numbered list per tool in plain words, the backups, and the report's path", async () => {
    const home = tmpDir("oc-short-action-");
    const { settings, hooksFile } = operatorWorld(home);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(3); // exit codes are unchanged: 3 = done, but you must act
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Updated to revision [0-9a-f]{12} \(generation [0-9a-f]{12}\) and brought OpenCadre's entries in 2 client config files current\. Not verified against a hub \(--offline\)\.$/);
    expect(r.out).toContain([
      "What you need to do:",
      "  1. Codex: Open Settings > Hooks in the Codex app (send one ordinary message in your work folder first, so Codex lists its hooks), or /hooks in Codex CLI, and approve the 2 changed OpenCadre hooks if they are listed for review.",
      "  2. Codex: One OpenCadre hook was not added back, because you may have removed it on purpose: PostToolUse typed-commit record. Run `connect` if you want it.",
      "",
    ].join("\n"));
    // Backups always show: two files changed, each kept its previous version.
    expect(backupsOf(settings)).toHaveLength(1);
    expect(backupsOf(hooksFile)).toHaveLength(1);
    expect(r.out).toMatch(/\nBackups: the previous version of each of the 2 changed files was kept next to it, ending in \.bak-\d{4}-\d\d-\d\dT[\d-]+Z\.\n/);
    expect(lines[lines.length - 1]).toBe(`Full report: ${reportOf(home)} (or add --verbose to print it here).`);
    // The per-file detail is NOT in the short form...
    expect(r.out).not.toMatch(/TO DO|Client config \(|trust: |Refreshed|Installed revision|matcher "Bash"|backs up and replaces/);
    // ...it is in the saved report, every line of it.
    const full = readFileSync(reportOf(home), "utf8");
    expect(full).toContain(`${settings}: changed (previous version kept as`);
    expect(full).toContain('PreToolUse approval gate: matcher "Bash" -> "Bash|PowerShell"');
    expect(full).toMatch(/TO DO: Not added, because it may have been removed on purpose: PostToolUse typed-commit record\./);
    expect(full).toMatch(/TO DO: Codex may list these OpenCadre hooks as changed/);
    expect(full).toContain("What you need to do:");
  });

  it("with nothing to do: the result line says so, and there is no list (the backups line still shows)", async () => {
    const home = tmpDir("oc-short-green-");
    const { settings } = connectedClaudePreF8(home);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^Updated to revision [0-9a-f]{12} \(generation [0-9a-f]{12}\) and brought OpenCadre's entries in 1 client config file current\. Not verified against a hub \(--offline\)\. Nothing for you to do\.$/);
    expect(r.out).not.toContain("What you need to do");
    expect(r.out).toContain(`Backups: the previous version of the changed file was kept next to it, ending in ${backupsOf(settings)[0].slice(backupsOf(settings)[0].lastIndexOf(".bak-"))}.`);
    // A second run: nothing changed, nothing backed up, so no backups line at all.
    const again = await upgradeShort(home);
    expect(again.code).toBe(0);
    expect(again.out).toBe([`Already current: revision ${again.out.match(/revision ([0-9a-f]{12})/)![1]} (generation ${again.out.match(/generation ([0-9a-f]{12})/)![1]}). Not verified against a hub (--offline). Nothing for you to do.`, "", `Full report: ${reportOf(home)} (or add --verbose to print it here).`, ""].join("\n"));
  });

  it("blocked: the file that could not be read is named in the short form, with exit 2", async () => {
    const home = tmpDir("oc-short-blocked-");
    const settings = path.join(home, ".claude", "settings.json");
    mkdirSync(settings, { recursive: true }); // a directory where the file should be: EISDIR, state unknown
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(2);
    expect(r.out.split("\n")[0]).toMatch(/Not finished: see below, then run the same command again\.$/);
    expect(r.out).toContain(`What you need to do:\n  1. Claude Code: ${settings} could not be read (EISDIR), so its state is unknown and it was left as it is. Fix access to it, then run the same command again.\n`);
  });

  it("--verbose prints the full report, which is exactly what the saved file holds", async () => {
    const home = tmpDir("oc-short-verbose-");
    operatorWorld(home);
    const r = await upgrade(home); // --verbose
    expect(r.code, r.out + r.err).toBe(3);
    const saved = readFileSync(reportOf(home), "utf8").split("\n");
    expect(saved[0]).toMatch(/^opencadre connect --upgrade, \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(r.out).toBe(`${saved.slice(2).join("\n")}\nThis report is also saved in ${reportOf(home)}.\n`);
    expect(r.out).toContain("Client config (OpenCadre-owned entries only");
    expect(r.out).toContain("What you need to do:"); // the short summary closes the full report
  });

  it("the report file holds no credential", async () => {
    const home = tmpDir("oc-short-nokey-");
    operatorWorld(home);
    const secret = "MARKER-credential-value-0123456789"; // not key-shaped on purpose: only its absence is asserted
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ hub: "https://hub.example", credential: secret, deviceId: "d1" }));
    const r = await upgradeShort(home);
    expect(r.code).toBe(3);
    expect(readFileSync(reportOf(home), "utf8")).not.toContain(secret);
    expect(r.out + r.err).not.toContain(secret);
  });

  // Review of #708 (Olive, F1): a server the user switched OFF stays off, but is owed in the SHORT form and exits 3,
  // like an OpenCadre hook switched off in Codex. Before the fix both of these exited 0 with "Nothing for you to do".
  it("a switched-off server in Claude Code's JSON stays off, is listed in the short form, and exits 3", async () => {
    const home = tmpDir("oc-short-off-json-");
    const { claudeJson } = connectedClaudePreF8(home);
    const config = JSON.parse(readFileSync(claudeJson, "utf8"));
    config.mcpServers["opencadre-session"].disabled = true;
    writeFileSync(claudeJson, `${JSON.stringify(config, null, 2)}\n`);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.out).not.toContain("Nothing for you to do");
    expect(r.out).toContain(`What you need to do:\n  1. Claude Code: OpenCadre's server is switched off in Claude Code (${claudeJson}), so Claude Code has no OpenCadre identity, mail or approvals.`);
    expect(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers["opencadre-session"].disabled).toBe(true); // kept off
  });

  it("a switched-off server in Codex's TOML (enabled = false) stays off, is listed in the short form, and exits 3", async () => {
    const home = tmpDir("oc-short-off-toml-");
    const { config } = connectedCodexCurrent(home);
    const withOff = readFileSync(config, "utf8").replace(/^(\[mcp_servers\.["']?opencadre-session["']?\][^\n]*\n)/m, "$1enabled = false\n");
    expect(withOff).toContain("enabled = false"); // the fixture really carries the switch
    writeFileSync(config, withOff);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.out).toContain(`Codex: OpenCadre's server is switched off in Codex (${config})`);
    expect(readFileSync(config, "utf8")).toBe(withOff); // byte-identical: nothing else was stale, and off stays off
  });

  it("a switched-off server whose entry is ALSO stale is updated, kept off, and still owed", async () => {
    const home = tmpDir("oc-short-off-stale-");
    const { claudeJson } = connectedClaudePreF8(home);
    const config = JSON.parse(readFileSync(claudeJson, "utf8"));
    Object.assign(config.mcpServers["opencadre-session"], { disabled: true, args: [...config.mcpServers["opencadre-session"].args, "--old-flag"] });
    writeFileSync(claudeJson, `${JSON.stringify(config, null, 2)}\n`);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.out).toContain("OpenCadre's server is switched off in Claude Code");
    const after = JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers["opencadre-session"];
    expect(after.disabled).toBe(true);
    expect(after.args).not.toContain("--old-flag");
  });

  // Review of #708 (Olive, F2): a previous config value is the user's text and may carry anything, so it never reaches
  // the report, printed or saved. The marker is NOT key-shaped on purpose: redaction cannot be what passes this.
  it("a previous server value (a token in stale args) reaches neither the printed report nor the saved one; it is in the backup", async () => {
    const SECRET = "SYNTHETIC-not-key-shaped-7f3a9c";
    for (const verbose of [false, true]) {
      const home = tmpDir(`oc-short-oldvalue-${verbose ? "v" : "s"}-`);
      const { claudeJson } = connectedClaudePreF8(home);
      const config = JSON.parse(readFileSync(claudeJson, "utf8"));
      config.mcpServers["opencadre-session"].args.push("--token", SECRET);
      writeFileSync(claudeJson, `${JSON.stringify(config, null, 2)}\n`);
      const r = verbose ? await upgrade(home) : await upgradeShort(home);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.out + r.err).not.toContain(SECRET);
      const saved = readFileSync(reportOf(home), "utf8");
      expect(saved).not.toContain(SECRET);
      expect(saved).toMatch(/opencadre-session args: changed, now \[.*\] \(the previous value is in the backup\)/);
      // Known positive: the value WAS there, and the backup (not the report) keeps it.
      const backup = backupsOf(claudeJson)[0];
      expect(readFileSync(path.join(path.dirname(claudeJson), backup), "utf8")).toContain(SECRET);
    }
  });

  it("a config file that is not valid JSON is named, but the source text V8 quotes into the parse error is not", async () => {
    const SECRET = "ZQX7SEC9"; // short: V8 quotes about ten characters either side of the error, so all of it shows
    const source = `{"mcpServers":{"opencadre-session":{"x":${SECRET}}}}`;
    expect(() => JSON.parse(source)).toThrow(SECRET); // known positive: the raw parse error DOES quote the secret
    const home = tmpDir("oc-short-badjson-");
    connectedClaudePreF8(home);
    const claudeJson = path.join(home, ".claude.json");
    writeFileSync(claudeJson, source);
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(2);
    expect(r.out).toContain(`${claudeJson} is not valid JSON (`);
    expect(r.out).toContain("the file's text is not shown");
    expect(r.out + r.err).not.toContain(SECRET);
    expect(readFileSync(reportOf(home), "utf8")).not.toContain(SECRET);
  });

  it("a report path that is a hard link is replaced, never written through to the file it links to", async () => {
    const home = tmpDir("oc-short-hardlink-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    const other = path.join(home, "unrelated.txt");
    writeFileSync(other, "KEEP ME\n");
    linkSync(other, reportOf(home));
    const r = await upgradeShort(home);
    expect(r.code, r.out + r.err).toBe(0);
    expect(readFileSync(other, "utf8")).toBe("KEEP ME\n");
    expect(readFileSync(reportOf(home), "utf8")).toMatch(/^opencadre connect --upgrade, /);
    expect(readdirSync(path.join(home, ".opencadre")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
