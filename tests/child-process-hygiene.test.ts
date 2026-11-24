// The vitest setup file tests/helpers/child-process-hygiene.ts: every child a test starts is hidden on Windows, and a
// child a test file leaves running is reaped through the handle the worker holds, without touching other processes.
import { afterAll, describe, expect, it } from "vitest";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { HIDE_MARK, reapOwnedChildren } from "./helpers/child-process-hygiene.js";
import { SPAWNERS, withWindowsHide } from "./helpers/windows-hide.js";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

const H = { windowsHide: true };
const cb = () => {};

describe("withWindowsHide", () => {
  it.each([
    ["spawn", ["node"], ["node", H]],
    ["spawn", ["node", ["-v"]], ["node", ["-v"], H]],
    ["spawn", ["node", ["-v"], { cwd: "x" }], ["node", ["-v"], { cwd: "x", windowsHide: true }]],
    ["spawn", ["node", { cwd: "x" }], ["node", { cwd: "x", windowsHide: true }]],
    ["spawn", ["node", undefined, { cwd: "x" }], ["node", undefined, { cwd: "x", windowsHide: true }]],
    ["spawnSync", ["node", ["-v"], undefined], ["node", ["-v"], H]],
    ["execFile", ["node", cb], ["node", H, cb]],
    ["execFile", ["node", ["-v"], cb], ["node", ["-v"], H, cb]],
    ["execFile", ["node", ["-v"], null, cb], ["node", ["-v"], H, cb]],
    ["execFileSync", ["git", ["status"], { stdio: "pipe" }], ["git", ["status"], { stdio: "pipe", windowsHide: true }]],
    ["exec", ["echo hi", cb], ["echo hi", H, cb]],
    ["exec", ["echo hi", { cwd: "x" }, cb], ["echo hi", { cwd: "x", windowsHide: true }, cb]],
    ["execSync", ["echo hi"], ["echo hi", H]],
    ["fork", ["m.js", ["a"]], ["m.js", ["a"], H]],
  ] as const)("%s(%j) gets windowsHide", (fn, args, expected) => {
    expect(withWindowsHide(fn, args)).toEqual(expected);
  });

  it("keeps an explicit choice and never mutates the caller's options", () => {
    const off = { windowsHide: false };
    expect(withWindowsHide("spawn", ["node", [], off])).toEqual(["node", [], { windowsHide: false }]);
    const opts = { cwd: "x" };
    withWindowsHide("spawn", ["node", [], opts]);
    expect(opts).toEqual({ cwd: "x" });
  });
});

describe("the setup file's patch", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("is in force for ESM named imports and for require()", () => {
    const required = createRequire(import.meta.url)("node:child_process") as Record<string, Record<symbol, unknown>>;
    expect((spawn as unknown as Record<symbol, unknown>)[HIDE_MARK]).toBe(true);
    for (const name of SPAWNERS) expect(required[name][HIDE_MARK], name).toBe(true);
  });

  it("starts a real child with windowsHide, and leaves an explicit false alone", async () => {
    const seen: unknown[] = [];
    const real = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function (this: ChildProcess, options: { windowsHide?: boolean }) {
      seen.push(options.windowsHide);
      return real.call(this, options);
    };
    try {
      await new Promise((r) => spawn(process.execPath, ["-e", ""]).on("exit", r));
      await new Promise((r) => spawn(process.execPath, ["-e", ""], { windowsHide: false }).on("exit", r));
    } finally {
      ChildProcess.prototype.spawn = real;
    }
    expect(seen).toEqual([true, false]);
  });

  it("keeps promisify(execFile) resolving { stdout, stderr }", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    expect({ stdout, stderr }).toEqual({ stdout: "out", stderr: "err" });
  });
});

describe("reaping", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // A process this file starts but deliberately leaves out of the reap, standing in for anything not ours.
  let bystander: ChildProcess | undefined;
  afterAll(() => { bystander?.kill(); });

  it("kills a still-running child and that child's own tree, and nothing else", async () => {
    // The parent starts a grandchild and reports its pid; the parent would run for two minutes, the grandchild for 20 s
    // (bounded, so a failing run of this test cannot leave it behind for long). The grandchild is detached,
    // so on Windows it is outside the kill-on-close job Node puts a non-detached child in, and only a tree kill ends it.
    const parent = spawn(process.execPath, ["-e", `
      const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true, detached: true });
      process.stdout.write(String(c.pid) + "\\n");
      setTimeout(() => {}, 120000);`]);
    let out = "";
    parent.stdout!.on("data", (d) => { out += d; });
    await waitFor(() => out.includes("\n"), "the grandchild's pid");
    const grandchild = Number(out.trim());

    bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
    const registry = (globalThis as unknown as Record<symbol, { owned: Set<ChildProcess> }>)[Symbol.for("opencadre.tests.childProcessRegistry")];
    expect(registry.owned.has(bystander)).toBe(true);
    registry.owned.delete(bystander);

    expect(await reapOwnedChildren()).toBeGreaterThanOrEqual(1);
    expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
    if (process.platform === "win32") await waitFor(() => !isAlive(grandchild), "the grandchild to be killed with its parent's tree", 5_000);
    expect(bystander.exitCode).toBeNull();
    expect(isAlive(bystander.pid!)).toBe(true);
  });

  type Registry = { owned: Set<ChildProcess>; original: Record<string, (...a: unknown[]) => unknown> };
  const registry = () => (globalThis as unknown as Record<symbol, Registry>)[Symbol.for("opencadre.tests.childProcessRegistry")];
  const exited = (c: ChildProcess) => new Promise<void>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once("exit", () => resolve());
  });
  // A process started through the builtin the setup file saved, so the tracker never sees it: it stands in for any
  // process on the machine that this worker did not start through the tracked handles.
  const untracked = () => {
    const c = registry().original.spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true }) as ChildProcess;
    expect(registry().owned.has(c)).toBe(false);
    return c;
  };
  const ready = (c: ChildProcess) => new Promise<void>((resolve, reject) => {
    c.stdout!.once("data", () => resolve());
    c.once("error", reject);
  });

  it("reaps an owned child and reports success, leaving an untracked process alone", async () => {
    const other = untracked();
    try {
      const owned = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 20000)"]);
      await ready(owned);
      expect(await reapOwnedChildren()).toBeGreaterThanOrEqual(1);
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      expect(other.exitCode).toBeNull();
      expect(isAlive(other.pid!)).toBe(true);
    } finally {
      other.kill();
      await exited(other);
    }
  });

  it("fails, naming the pid and command, when an owned child survives a refused kill and the wait", async () => {
    const other = untracked();
    const marker = "reap-refused-" + process.pid;
    const child = spawn(process.execPath, ["-e", `process.stdout.write('ready'); setTimeout(() => {}, 20000) // ${marker}`]);
    const reg = registry();
    const realSpawnSync = reg.original.spawnSync;
    const realKill = child.kill.bind(child);
    try {
      await ready(child);
      // taskkill denied and the handle's kill refused: nothing can end the child, so the reap must not report success.
      reg.original.spawnSync = () => ({ status: 1, error: new Error("simulated taskkill denial") });
      child.kill = () => false;
      const reap = reapOwnedChildren(40);
      await expect(reap).rejects.toThrow(`pid ${child.pid}`);
      await expect(reap).rejects.toThrow(marker);
      expect(child.exitCode).toBeNull();
      expect(isAlive(child.pid!)).toBe(true);
      expect(isAlive(other.pid!)).toBe(true);
    } finally {
      reg.original.spawnSync = realSpawnSync;
      child.kill = realKill;
      // End the child through its own handle, so the test leaves nothing behind whatever happened above.
      realKill("SIGKILL");
      other.kill();
      await Promise.all([exited(child), exited(other)]);
    }
  });
});
