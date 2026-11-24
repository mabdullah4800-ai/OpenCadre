// #692 review follow-up: five defects reproduced by Olive and confirmed by Codex-049a at 315ae8c7, each pinned here by a
// named test (her probe, B:/ai-work/temp/olive-692-review-20261001/olive-692-probe.mjs and olive-692-additional.mjs,
// turned into assertions on its OUTPUT fields, since the probe itself exits 0 either way).
//   1. Windows basic-quoted TOML hook-state keys were not decoded -> a disabled hook was rewritten.
//   2. A failure after an earlier successful write escaped and erased the receipt.
//   3. Ownership was a substring: an `echo "<bin>/opencadre-awareness.mjs"` hook was rewritten into a node invocation.
//   4. Two parts of one shared file got the same backup name: the second backup overwrote the first (the original).
//   5. Every read error counted as "absent": an unreadable settings.json or config.toml was silently skipped.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";
import { planCodexSessionServer, planGeminiSessionServer, planSessionServer } from "../cli/lib/device.mjs";
import { applyReconcile, codexHookStates, describeReconcile, planReconcile, reconcileOutcome } from "../cli/lib/reconcile.mjs";

delete process.env.CODEX_HOME;

type Part = { kind: string; file: string; status: string; backup?: string; error?: string; notes?: string[]; actions?: string[] };
type Client = { client: string; parts: Part[] };

const bin = (home: string) => path.join(home, ".opencadre", "bin");
const paths = (home: string) => ({
  awarenessPath: path.join(bin(home), "opencadre-awareness.mjs"), wakePath: path.join(bin(home), "opencadre-wake.mjs"), usagePath: path.join(bin(home), "opencadre-usage.mjs"),
  gatePath: path.join(bin(home), "opencadre-approval-gate.mjs"), stampPath: path.join(bin(home), "opencadre-session-stamp.mjs"),
});
const save = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const part = (clients: Client[], client: string, kind: string) => clients.find((c) => c.client === client)!.parts.find((p) => p.kind === kind)!;
const backupsOf = (file: string) => readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-`)).sort();
const NOW = new Date("2026-10-01T12:00:00Z");
const STAMP = NOW.toISOString().replace(/[:.]/g, "-");

/** Codex connected by the current writers, with one stale (older) PostToolUse matcher. */
function codexWithOldMatcher(home: string) {
  const server = planCodexSessionServer({ home, proxyPath: path.join(bin(home), "opencadre-mcp.mjs") });
  save(server.file, server.after);
  const hooks = planSessionHooks({ home, client: "codex", ...paths(home) });
  const h = JSON.parse(hooks.after);
  h.hooks.PostToolUse[0].matcher = "Edit|Write|Bash|apply_patch";
  save(hooks.file, `${JSON.stringify(h, null, 2)}\n`);
  return { config: server.file, hooksFile: hooks.file };
}

/** Claude Code connected, with BOTH parts stale: the server's command and the pre-F8 gate matcher. */
function claudeBothStale(home: string) {
  const server = planSessionServer({ home, client: "claude-code", proxyPath: path.join(bin(home), "opencadre-mcp.mjs") });
  const s = JSON.parse(server.after);
  s.mcpServers["opencadre-session"].command = "outdated-node";
  save(server.file, `${JSON.stringify(s, null, 2)}\n`);
  const hook = planSessionHooks({ home, client: "claude-code", ...paths(home) });
  const h = JSON.parse(hook.after);
  h.hooks.PreToolUse[0].matcher = "Bash";
  save(hook.file, `${JSON.stringify(h, null, 2)}\n`);
  return { server: server.file, settings: hook.file, serverBefore: readFileSync(server.file, "utf8"), settingsBefore: readFileSync(hook.file, "utf8") };
}

describe("1. Codex hook-state keys are TOML-decoded (both quote forms, Windows paths, comments)", () => {
  for (const quote of ["literal", "basic"] as const) {
    it(`a ${quote}-quoted Windows key with comments: the disabled slot is recognised and hooks.json stays byte-identical`, () => {
      const home = tmpDir(`oc-rv-toml-${quote}-`);
      const { config, hooksFile } = codexWithOldMatcher(home);
      const key = `${hooksFile}:post_tool_use:0:0`;
      const table = quote === "literal" ? `'${key}'` : JSON.stringify(key);
      writeFileSync(config, `${readFileSync(config, "utf8")}\n[hooks.state.${table}] # set in the app\nenabled = false # off on purpose\n`);
      const before = readFileSync(hooksFile, "utf8");
      const states = codexHookStates(home, hooksFile);
      expect(states.size).toBe(1);
      expect(states.get("post_tool_use:0:0")?.enabled).toBe(false);
      const result = applyReconcile({ home });
      expect(readFileSync(hooksFile, "utf8")).toBe(before);
      expect(part(result.clients, "codex", "hooks").status).toBe("report");
      expect(backupsOf(hooksFile)).toEqual([]);
    });
  }

  it("an UNCHANGED install with a disabled OpenCadre hook says so (an action), and writes nothing", () => {
    const home = tmpDir("oc-rv-off-current-");
    const server = planCodexSessionServer({ home, proxyPath: path.join(bin(home), "opencadre-mcp.mjs") });
    save(server.file, server.after);
    const hooks = planSessionHooks({ home, client: "codex", ...paths(home) });
    save(hooks.file, hooks.after);
    writeFileSync(server.file, `${server.after}\n[hooks.state.${JSON.stringify(`${hooks.file}:post_tool_use:0:0`)}]\nenabled = false\n`);
    const result = planReconcile({ home });
    const p = part(result.clients, "codex", "hooks");
    expect(p.status).toBe("report");
    expect((p.actions ?? []).join(" ")).toMatch(/You turned off PostToolUse awareness in Codex; it stays off/);
    expect(reconcileOutcome(result.clients)).toBe("action");
  });
});

describe("2. a partial apply keeps its receipt: earlier writes and backups, the failing component and its error", () => {
  for (const [step, stage, status] of [["planned", "planning", "failed"], ["backup", "backup", "failed"], ["replace", "replace", "failed"], ["replaced", "revalidation", "applied-unverified"]] as const) {
    it(`a failure at ${stage} of the SECOND file, after the first was written, is reported per file and blocked`, () => {
      const home = tmpDir(`oc-rv-partial-${stage}-`);
      const { server, settings, serverBefore, settingsBefore } = claudeBothStale(home);
      const codex = codexWithOldMatcher(home);
      const codexBefore = readFileSync(codex.hooksFile, "utf8");
      const result = applyReconcile({ home, now: NOW, onStep: (s: string, info: { file: string }) => {
        if (s === step && info.file === settings) throw Object.assign(new Error(`induced ${s} failure`), { code: "EIO" });
      } });
      const first = part(result.clients, "claude-code", "server");
      const second = part(result.clients, "claude-code", "hooks");
      // The earlier success survives in the receipt, and its backup holds the ORIGINAL bytes.
      expect(first.status).toBe("applied");
      expect(readFileSync(first.backup!, "utf8")).toBe(serverBefore);
      expect(readFileSync(server, "utf8")).not.toBe(serverBefore);
      // The failing component and its error.
      expect(second.status).toBe(status);
      expect(second.error).toMatch(new RegExp(`^${stage} failed \\(EIO\\)$`));
      if (status === "failed") expect(readFileSync(settings, "utf8")).toBe(settingsBefore);
      else expect(readFileSync(second.backup!, "utf8")).toBe(settingsBefore);
      // Everything after it is deferred and untouched.
      expect(part(result.clients, "codex", "hooks").status).toBe("deferred");
      expect(readFileSync(codex.hooksFile, "utf8")).toBe(codexBefore);
      expect(reconcileOutcome(result.clients)).toBe("blocked");
      // What the user reads: both named, nothing claimed "unchanged" that changed.
      const text = describeReconcile(result.clients, { dryRun: false }).join("\n");
      expect(text).toContain(`${server}: changed (previous version kept as ${first.backup})`);
      expect(text).toContain(`${settings}: ${status === "failed" ? "NOT changed (failed)" : "changed, then changed again by another program"}`);
      expect(text).toMatch(new RegExp(`${stage} failed \\(EIO\\)`));
      expect(text).not.toMatch(/no client config file was changed/);
    });
  }

  it("(c) a REAL post-write read failure (Codex's config.toml becomes unreadable during revalidation) keeps the receipt", () => {
    const home = tmpDir("oc-rv-postwrite-");
    const { config, hooksFile } = codexWithOldMatcher(home);
    const before = readFileSync(hooksFile, "utf8");
    const result = applyReconcile({ home, now: NOW, onStep: (s: string, info: { file: string }) => {
      if (s === "replaced" && info.file === hooksFile) {
        renameSync(config, `${config}.moved`);
        mkdirSync(config); // config.toml is now a directory: reading Codex's hook state fails with EISDIR
      }
    } });
    const p = part(result.clients, "codex", "hooks");
    expect(p.status).toBe("applied-unverified");
    expect(p.error).toMatch(/^revalidation failed \((EISDIR|EPERM|EACCES)\)$/);
    expect(readFileSync(p.backup!, "utf8")).toBe(before);
    expect(reconcileOutcome(result.clients)).toBe("blocked");
  });
});

describe("3. ownership is proven by execution, not by a substring", () => {
  for (const [label, command] of [
    ["echo", (p: string) => `echo "${p}"`],
    ["a wrapper with more shell", (p: string) => `bash -c 'node "${p}" --client claude-code; rm -rf /tmp/x'`],
    ["a pipe", (p: string) => `node "${p}" --client claude-code | tee log.txt`],
  ] as const) {
    it(`a hook that only mentions an in-bin helper (${label}) is never rewritten, and is reported`, () => {
      const home = tmpDir("oc-rv-echo-");
      const hook = planSessionHooks({ home, client: "claude-code", ...paths(home) });
      const h = JSON.parse(hook.after);
      h.hooks.SessionStart[0].hooks[0].command = command(paths(home).awarenessPath);
      h.hooks.PreToolUse[0].matcher = "Bash"; // stale elsewhere, so a substring owner WOULD rewrite this file
      save(hook.file, `${JSON.stringify(h, null, 2)}\n`);
      const before = readFileSync(hook.file, "utf8");
      const result = applyReconcile({ home });
      expect(readFileSync(hook.file, "utf8")).toBe(before);
      const p = part(result.clients, "claude-code", "hooks");
      expect(p.status).toBe("report");
      expect((p.notes ?? []).join(" ")).toMatch(/mention an OpenCadre helper without simply running it \(SessionStart awareness\)/);
      expect(backupsOf(hook.file)).toEqual([]);
    });
  }
});

describe("4. backups are exclusive and unique: no receipt is ever overwritten", () => {
  it("(b) two stale parts of ONE shared file (Gemini settings.json) get two distinct backups; the first holds the original", () => {
    const home = tmpDir("oc-rv-shared-");
    const server = planGeminiSessionServer({ home, proxyPath: path.join(bin(home), "opencadre-mcp.mjs") });
    const s = JSON.parse(server.after);
    s.mcpServers["opencadre-session"].command = "outdated-node";
    save(server.file, `${JSON.stringify(s, null, 2)}\n`);
    const hooks = planSessionHooks({ home, client: "gemini", ...paths(home) });
    const h = JSON.parse(hooks.after);
    h.hooks.SessionStart[0].hooks[0].timeout = 5000; // ours is 10000 ms
    save(hooks.file, `${JSON.stringify(h, null, 2)}\n`);
    const original = readFileSync(server.file, "utf8");
    const result = applyReconcile({ home, now: NOW });
    const a = part(result.clients, "gemini", "server");
    const b = part(result.clients, "gemini", "hooks");
    expect(a.status).toBe("applied");
    expect(b.status).toBe("applied");
    expect(a.backup).not.toBe(b.backup);
    expect(readFileSync(a.backup!, "utf8")).toBe(original);
    expect(readFileSync(b.backup!, "utf8")).not.toBe(original); // the bytes after the first part, its own receipt
    expect(backupsOf(server.file)).toEqual([`settings.json.bak-${STAMP}`, `settings.json.bak-${STAMP}-2`]);
  });

  it("(a) a pre-existing .bak file with the would-be name is never overwritten (non-clobber control)", () => {
    const home = tmpDir("oc-rv-clobber-");
    const { settings, settingsBefore } = claudeBothStale(home);
    const taken = `${settings}.bak-${STAMP}`;
    writeFileSync(taken, "a backup the user made by hand\n");
    mkdirSync(`${settings}.bak-${STAMP}-2`); // and the next name is a directory (Olive's EISDIR shape)
    const result = applyReconcile({ home, now: NOW });
    const p = part(result.clients, "claude-code", "hooks");
    expect(p.status).toBe("applied");
    expect(readFileSync(taken, "utf8")).toBe("a backup the user made by hand\n");
    expect(p.backup).toBe(`${settings}.bak-${STAMP}-3`);
    expect(readFileSync(p.backup!, "utf8")).toBe(settingsBefore);
  });
});

describe("5. only ENOENT is absent: an unreadable config is BLOCKED, never skipped or rewritten", () => {
  it("an EISDIR settings.json on a connected Claude Code home is a blocked component, not 'no hooks'", () => {
    const home = tmpDir("oc-rv-eisdir-");
    const server = planSessionServer({ home, client: "claude-code", proxyPath: path.join(bin(home), "opencadre-mcp.mjs") });
    save(server.file, server.after);
    mkdirSync(path.join(home, ".claude", "settings.json"), { recursive: true });
    const result = planReconcile({ home });
    const p = part(result.clients, "claude-code", "hooks");
    expect(p.status).toBe("blocked");
    expect((p.notes ?? []).join(" ")).toMatch(/could not be read \(EISDIR|EPERM|EACCES/);
    expect(reconcileOutcome(result.clients)).toBe("blocked");
  });

  it("(c) an unreadable Codex config.toml (hook state unknown) never authorises a hooks rewrite: blocked", () => {
    const home = tmpDir("oc-rv-statefail-");
    const { config, hooksFile } = codexWithOldMatcher(home);
    const before = readFileSync(hooksFile, "utf8");
    renameSync(config, `${config}.moved`);
    mkdirSync(config);
    const result = applyReconcile({ home });
    expect(readFileSync(hooksFile, "utf8")).toBe(before);
    expect(part(result.clients, "codex", "hooks").status).toBe("blocked");
    expect(backupsOf(hooksFile)).toEqual([]);
    expect(reconcileOutcome(result.clients)).toBe("blocked");
  });
});
