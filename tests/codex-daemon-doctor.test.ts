import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexDaemonVersionWarning } from "../cli/lib/codex-daemon.mjs";

const CLI = fileURLToPath(new URL("../cli/bin/opencadre.mjs", import.meta.url));
function doctorWithFake(version?: string, spaced = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-doctor-daemon-"));
  const pathDir = spaced ? path.join(dir, "with space") : dir;
  mkdirSync(pathDir, { recursive: true });
  if (version) writeFileSync(path.join(pathDir, "codex.cmd"), `@echo off\r\necho codex-cli ${version}\r\n`);
  const env = { ...process.env, PATH: pathDir, Path: pathDir, CODEX_HOME: "" };
  try {
    return spawnSync(process.execPath, [CLI, "doctor", "--client", "codex", "--home", dir], {
      env, encoding: "utf8", timeout: 15_000,
    });
  } finally {
    if (!path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unsafe test cleanup path");
    rmSync(dir, { recursive: true, force: true });
  }
}

// Windows is the measured host for the 0.157.0 breakaway failure. A real .cmd fixture tests
// discovery, launch and output parsing, not just a mocked classifier.
// A healthy Codex home includes Codex's own trust records for the OpenCadre hooks (#626: doctor reports
// hooks_untrusted without them). Doctor observes the record; the test never reproduces Codex's hash algorithm.
function recordTestHookTrust(home: string) {
  const config = path.join(home, ".codex", "config.toml");
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const source = hooksFile.replaceAll("\\", "/");
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8")).hooks;
  const tables = Object.entries(hooks).flatMap(([event, groups]) =>
    (groups as Array<{ hooks: Array<{ command: string }> }>).flatMap((group, groupIndex) =>
      group.hooks.flatMap((handler, handlerIndex) =>
        handler.command.includes("opencadre-")
          ? [`[hooks.state.'${source}:${event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}:${groupIndex}:${handlerIndex}']\ntrusted_hash = "sha256:test-record"\n`]
          : [])));
  writeFileSync(config, `${readFileSync(config, "utf8")}\n${tables.join("\n")}`);
}

describe.skipIf(process.platform !== "win32")("Codex CLI daemon version advisory in default doctor", () => {
  it("warns on a fake 0.157.0 executable, naming the real TUI confirmation step and fix", () => {
    const r = doctorWithFake("0.157.0");
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("[amber] Codex CLI 0.157.0 may fail");
    expect(r.stdout).toContain("Run `codex` with no arguments");
    expect(r.stdout).toContain("upgrade the Codex CLI to 0.157.1 or newer");
    expect(r.stdout).toContain("verdict=not_connected");
    expect(r.status).toBe(1); // Version risk cannot change the wiring verdict or exit code.
  });

  it("warns when npm's codex.cmd lives under a path containing spaces", () => {
    const r = doctorWithFake("0.157.0", true);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("[amber] Codex CLI 0.157.0 may fail");
    expect(r.stdout).toContain("verdict=not_connected");
  });

  it("does not warn for a fake 0.157.1 executable", () => {
    const r = doctorWithFake("0.157.1");
    expect(r.error).toBeUndefined();
    expect(r.stdout).not.toContain("daemon detachment");
    expect(r.stdout).toContain("verdict=not_connected");
    expect(r.status).toBe(1);
  });

  it("keeps a healthy connected home healthy and exit 0 despite the advisory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-daemon-healthy-"));
    const priorDb = process.env.OPENCADRE_DB_PATH;
    process.env.OPENCADRE_DB_PATH = path.join(dir, "hub.db");
    process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
    const { childEnv, mintDevice, operatorWorkspace, runNode, startHub } = await import("./helpers/device-hub.js");
    const hub = await startHub();
    try {
      const { operatorKey } = await operatorWorkspace("Daemon advisory control");
      const minted = await mintDevice(hub.url, operatorKey, "codex");
      const home = path.join(dir, "home");
      mkdirSync(home);
      const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
      expect(connected.code, connected.err).toBe(0);
      recordTestHookTrust(home);
      const pathDir = path.join(dir, "with space");
      mkdirSync(pathDir);
      writeFileSync(path.join(pathDir, "codex.cmd"), "@echo off\r\necho codex-cli 0.157.0\r\n");
      const doctor = await runNode(CLI, ["doctor", "--client", "codex", "--home", home], { ...childEnv(home), PATH: pathDir, Path: pathDir });
      expect(doctor.out).toContain("[amber] Codex CLI 0.157.0 may fail");
      // The advisory never degrades the verdict: this home's best verdict since the #692 follow-up is the amber
      // hook_trust_unverified (recorded Codex trust is not verified trust), exit 3 -- not a fault (exit 1).
      expect(doctor.out).toContain("verdict=hook_trust_unverified");
      expect(doctor.code).toBe(3);
    } finally {
      await hub.close();
      const { db } = await import("../src/db.js");
      db.close();
      if (priorDb === undefined) delete process.env.OPENCADRE_DB_PATH;
      else process.env.OPENCADRE_DB_PATH = priorDb;
      if (!path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unsafe test cleanup path");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not crash or warn when Codex is absent", () => {
    const r = doctorWithFake();
    expect(r.error).toBeUndefined();
    expect(r.stdout).not.toContain("daemon detachment");
    expect(r.stdout).toContain("verdict=not_connected");
    expect(r.status).toBe(1);
  });
});

it("does not warn on non-Windows hosts where this version failure was not measured", () => {
  expect(codexDaemonVersionWarning({ platform: "linux", executable: "unused" })).toBeNull();
});
