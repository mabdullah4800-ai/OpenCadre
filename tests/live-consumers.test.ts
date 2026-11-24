// The live-consumer inventory `connect --upgrade` reads before converting an install (cli/lib/generations.mjs
// liveConsumers), PR-A of the premise plan (§3.F). Measured on 2026-10-01: wake locks from 09-23 and 09-26 named pids
// that svchost.exe (started 09-28) held, and the inventory counted both as live wake watchers because it trusted any live
// pid. A recorded pid now counts only while that process is still the helper that wrote the record: its creation time
// and its command line (or, where the command line is hidden, its executable) are checked, and what cannot be read is
// UNKNOWN and counted, labelled. Each record it ignores is listed with the reason.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { judgeRecordedPid, liveConsumers, processTable, redactCommandLine } from "../cli/lib/generations.mjs";
import { HELPERS, installedText } from "../cli/lib/helpers.mjs";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

let server: http.Server;
let baseUrl: string;
const started: ChildProcess[] = [];
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  // Only processes this file started, by their own handles.
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const tempHome = () => {
  const home = mkdtempSync(path.join(tmpdir(), "oc-consumers-"));
  mkdirSync(path.join(home, ".opencadre", "bin"), { recursive: true });
  return home;
};
const bin = (home: string) => path.join(home, ".opencadre", "bin");

/** A harmless long-lived process this test owns, which is NOT a wake watcher: what a reused pid looks like. */
function unrelated(...args: string[]) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore" });
  started.push(child);
  return child;
}

/** Installs every helper into `home`'s ~/.opencadre/bin, as a pre-generation install would hold them. */
function installHelpers(home: string) {
  for (const name of Object.keys(HELPERS)) {
    const file = path.join(bin(home), ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, installedText(name));
  }
  return path.join(bin(home), "opencadre-wake.mjs");
}

/** A real wake watcher, run from its installed copy and waiting on a hub in this process, with its state in `home`'s
 * ~/.opencadre. */
async function realWatcher(home: string) {
  const { orgId } = createOrganization(`Consumers ${path.basename(home)}`);
  const me = registerAgent(orgId, "Sleeper");
  const stateDir = path.join(home, ".opencadre");
  const child = spawn(process.execPath, [installHelpers(home), "--rewake"], {
    env: { ...process.env, OPENCADRE_URL: baseUrl, OPENCADRE_KEY: me.apiKey, OPENCADRE_WAIT_SECONDS: "1", OPENCADRE_WAKE_STATE_DIR: stateDir, OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "oc-consumers-hook-")), CLAUDE_CODE_SESSION_ATTENDED: "1" },
  });
  started.push(child);
  child.stdin!.end("{}");
  const lockPath = path.join(stateDir, `wake-${createHash("sha256").update(me.apiKey).digest("hex").slice(0, 16)}.lock`);
  await waitFor(() => existsSync(lockPath), "the watcher to take its lock");
  return { child, lockPath };
}

describe("liveConsumers: a recorded pid counts only while it is still that helper", { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it("a lock whose pid is alive but is not a wake watcher is NOT counted, and is listed as a stale lock ignored", async () => {
    const home = tempHome();
    // Its command line carries a secret-shaped argument, which the report must not repeat.
    const other = unrelated("--token", "not-a-real-secret-4c1e");
    const lock = path.join(home, ".opencadre", "wake-0123456789abcdef.lock");
    writeFileSync(lock, JSON.stringify({ pid: other.pid, startedAt: Date.now() }));
    const found = liveConsumers({ home, bin: bin(home), env: {} });
    expect(found.consumers.map((c) => c.pid)).not.toContain(other.pid);
    const ignored = found.ignored.find((c) => c.pid === other.pid);
    expect(ignored?.kind).toBe("stale lock ignored");
    expect(ignored?.detail).toMatch(new RegExp(`pid ${other.pid} was reused by node`, "i"));
    expect(ignored?.detail).toContain(lock);
    expect(ignored?.detail).toContain("--token [redacted]");
    expect(ignored?.detail).not.toContain("not-a-real-secret-4c1e");
  });

  it("a real wake watcher is counted, and says why: its start and its command", async () => {
    const home = tempHome();
    const { child, lockPath } = await realWatcher(home);
    const found = liveConsumers({ home, bin: bin(home), env: {} });
    const watcher = found.consumers.find((c) => c.pid === child.pid);
    expect(watcher?.kind).toBe("wake watcher");
    expect(watcher?.detail).toMatch(/^started \d{4}-\d\d-\d\d \d\d:\d\d, command .*opencadre-wake\.mjs --rewake/);
    expect(watcher?.detail).toContain(lockPath);
    expect(found.ignored).toEqual([]);
    child.kill();
  });

  it("an old-format lock (a pid and nothing else) is judged by the process alone", async () => {
    const home = tempHome();
    const { child } = await realWatcher(home);
    const other = unrelated();
    const dir = path.join(home, ".opencadre");
    writeFileSync(path.join(dir, "wake-aaaaaaaaaaaaaaaa.lock"), JSON.stringify({ pid: child.pid }));
    writeFileSync(path.join(dir, "wake-bbbbbbbbbbbbbbbb.lock"), JSON.stringify({ pid: other.pid }));
    const found = liveConsumers({ home, bin: bin(home), env: {} });
    expect(found.consumers.filter((c) => c.kind === "wake watcher").map((c) => c.pid)).toEqual([child.pid]);
    expect(found.ignored.map((c) => c.pid)).toEqual([other.pid]);
    child.kill();
  });

  it("an MCP proxy record gets the same scrutiny: a reused proxyPid is ignored", async () => {
    const home = tempHome();
    const other = unrelated();
    const run = path.join(home, ".opencadre", "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, "qwen-4242.json"), JSON.stringify({ client: "qwen", hostPid: 4242, proxyPid: other.pid, seat: "s", mode: "process", at: new Date().toISOString() }));
    const found = liveConsumers({ home, bin: bin(home), env: {} });
    expect(found.consumers.map((c) => c.pid)).not.toContain(other.pid);
    expect(found.ignored.find((c) => c.pid === other.pid)?.kind).toBe("stale proxy record ignored");
  });

  it("the process list this machine gives names a live process, its start and its executable", () => {
    const table = processTable();
    expect(table).not.toBeNull();
    const me = table!.find((p) => p.pid === process.pid);
    expect(me?.name).toMatch(/^node(\.exe)?$/i);
    expect(Math.abs(me!.startedAt! - (Date.now() - process.uptime() * 1000))).toBeLessThan(5000);
  });
});

describe("judgeRecordedPid: the evidence rules, including what this user cannot read", () => {
  const writtenAt = Date.parse("2026-09-23T10:00:00Z");
  const rec = (extra = {}) => ({ pid: 9720, helper: "opencadre-wake.mjs", label: "wake watcher", writtenAt, ...extra });
  const live = () => true;
  // An installed watcher's path and command line, in this platform's form.
  const helperPath = path.join(path.resolve(path.sep, "home", "u"), ".opencadre", "bin", "opencadre-wake.mjs");
  const node = path.resolve(path.sep, "opt", "nodejs", process.platform === "win32" ? "node.exe" : "node");
  const installed = `${node} ${helperPath} --rewake`;

  it("the measured case: svchost.exe, started after the lock, command line hidden -> stale, and says so", () => {
    const j = judgeRecordedPid(rec(), [{ pid: 9720, name: "svchost.exe", startedAt: Date.parse("2026-09-28T08:00:00Z"), line: null }], live);
    expect(j.verdict).toBe("stale");
    expect(j.why).toMatch(/^pid 9720 was reused by svchost\.exe \(started 2026-09-28/);
    // With no creation time to go on, the executable alone still says it is not a watcher.
    const noTime = judgeRecordedPid(rec(), [{ pid: 9720, name: "svchost.exe", startedAt: null, line: null }], live);
    expect(noTime.verdict).toBe("stale");
    expect(noTime.why).toContain("not a JavaScript runtime");
  });

  it("a creation time after the record was written is reuse, whatever the process claims to be", () => {
    const j = judgeRecordedPid(rec(), [{ pid: 9720, name: "node.exe", startedAt: writtenAt + 60_000, line: installed }], live);
    expect(j.verdict).toBe("stale");
  });

  it("a creation time other than the writer's own process start (procStart) is another incarnation", () => {
    const j = judgeRecordedPid(rec({ procStart: writtenAt - 600_000 }), [{ pid: 9720, name: "node.exe", startedAt: writtenAt - 1000, line: installed }], live);
    expect(j.verdict).toBe("stale");
    const same = judgeRecordedPid(rec({ procStart: writtenAt - 1000 }), [{ pid: 9720, name: "node.exe", startedAt: writtenAt - 1200, line: installed }], live);
    expect(same.verdict).toBe("live");
  });

  it("a helper is PROVEN only by a JavaScript runtime whose script is the installed helper; one that only names it is UNKNOWN", () => {
    const judge = (line: string, name = "node.exe", bins: string[] = []) => judgeRecordedPid(rec({ procStart: writtenAt - 1000, bins }), [{ pid: 9720, name, startedAt: writtenAt - 1200, line }], live);
    // Olive's #694 control: a shell that echoes the canonical helper path names it and runs nothing.
    expect(judge(`cmd /c echo "${helperPath}"`, "cmd.exe").verdict).toBe("unknown");
    // Not a JavaScript runtime, though its first argument is the helper: an editor that has the file open runs nothing.
    expect(judge(`${path.resolve(path.sep, "opt", "editor", "notepad.exe")} ${helperPath}`, "notepad.exe").verdict).toBe("unknown");
    expect(judge(`${node} -e "setInterval(() => {}, 1000)" -- ${helperPath}`).verdict).toBe("unknown"); // an eval
    expect(judge(`${node} -r ${helperPath} ${path.resolve(path.sep, "elsewhere", "other.mjs")}`).verdict).toBe("unknown"); // preloaded only
    expect(judge(`${node} ${path.resolve(path.sep, "tmp", "copy", "opencadre-wake.mjs")}`).verdict).toBe("unknown"); // a copy outside an install
    // The positive controls: the installed helper, a generation's copy, and the upgraded install's own bin anywhere.
    expect(judge(installed).verdict).toBe("live");
    expect(judge(`${node} --no-warnings ${path.join(path.dirname(helperPath), ".gen", "0123456789ab", "opencadre-wake.mjs")} --rewake`).verdict).toBe("live");
    const custom = path.resolve(path.sep, "srv", "oc", "bin");
    expect(judge(`${node} ${path.join(custom, "opencadre-wake.mjs")}`, "node.exe", [custom]).verdict).toBe("live");
    expect(judge(`${node} ${path.join(custom, "opencadre-wake.mjs")}`).verdict).toBe("unknown");
    // Olive's #694 control at b9875de2: the helper is only an option's VALUE; real Node runs other.mjs alone.
    const other = path.resolve(path.sep, "elsewhere", "other.mjs");
    expect(judge(`${node} --redirect-warnings ${helperPath} ${other}`).verdict).toBe("unknown");
    expect(judge(`${node} --redirect-warnings=${path.resolve(path.sep, "w.log")} ${helperPath}`).verdict).toBe("live"); // value attached
    // An option the parser does not know may take the next argument: what runs is not provable.
    expect(judge(`${node} --some-future-option ${helperPath} --rewake`).verdict).toBe("unknown");
    expect(judge(`${node} --some-future-option=1 ${helperPath} --rewake`).verdict).toBe("unknown");
    // A line that does not name the helper at all is a reused pid.
    expect(judge(`${node} server.js`).verdict).toBe("stale");
  });

  it("a hidden command line on a JavaScript runtime is UNKNOWN (counted), never evidence either way", () => {
    expect(judgeRecordedPid(rec(), [{ pid: 9720, name: "node.exe", startedAt: writtenAt - 1000, line: null }], live).verdict).toBe("unknown");
    expect(judgeRecordedPid(rec(), [{ pid: 9720, name: null, startedAt: null, line: null }], live).verdict).toBe("unknown");
    // No process list at all: unknown too, and a dead pid is plainly stale.
    expect(judgeRecordedPid(rec(), null, live).verdict).toBe("unknown");
    expect(judgeRecordedPid(rec(), null, () => false).verdict).toBe("stale");
  });

  it("an unreadable process list counts every running recorded pid as UNVERIFIED and says the list could not be read", () => {
    const home = tempHome();
    writeFileSync(path.join(home, ".opencadre", "wake-0123456789abcdef.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const found = liveConsumers({ home, bin: bin(home), env: {}, table: () => null });
    expect(found.consumers).toHaveLength(1);
    expect(found.consumers[0].detail).toMatch(/^UNVERIFIED, /);
    expect(found.caveats.join(" ")).toContain("could not be read");
  });

  it("command lines are printed without anything credential-shaped", () => {
    const key = ["agt", "Z".repeat(24)].join("_");
    const out = redactCommandLine(`node x.mjs --key ${key} OPENCADRE_KEY=${key} --token abc Bearer abc`);
    expect(out).not.toContain(key);
    expect(out).not.toMatch(/\babc\b/);
  });
});
