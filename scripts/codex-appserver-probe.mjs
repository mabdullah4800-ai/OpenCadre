#!/usr/bin/env node
// Zero-token probe: drive `codex app-server` over stdio with two thread/start calls
// and record which child processes each one spawns.
//
// Settles HARNESS-CODEX.md section 5.3 / section 9 gap 3: whether two chats share
// one MCP proxy process, or each gets its own. No model call is made: we initialize,
// start two threads, and stop. Nothing in the protocol below requires a turn.
//
// Usage: node scripts/codex-appserver-probe.mjs [path-to-codex.exe]
// Read-only with respect to the repo. The child writes to the user's own
// ~/.codex logs, exactly as the desktop app does.

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const CODEX =
  process.argv[2] ||
  process.env.CODEX_BIN ||
  "C:\\Users\\dev\\.codex\\.sandbox-bin\\codex.exe";

const CWD = process.cwd();

// ---- process bookkeeping -----------------------------------------------------

// Every process we see whose command line mentions the MCP proxy, keyed by pid.
// We sample repeatedly because children appear a beat after the RPC returns.
function snapshotProxies() {
  const ps = `
    Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -match 'opencadre-mcp|mcp-server|rmcp' } |
      Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine |
      ConvertTo-Json -Compress -Depth 3
  `;
  let raw;
  try {
    raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    }).trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Descendants of the app-server pid, transitively.
function descendantsOf(rootPid, procs) {
  const byParent = new Map();
  for (const p of procs) {
    if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, []);
    byParent.get(p.ParentProcessId).push(p);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.ProcessId)) continue;
      seen.add(child.ProcessId);
      out.push(child);
      queue.push(child.ProcessId);
    }
  }
  return out;
}

function describe(p) {
  return {
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    cmd: (p.CommandLine || "").slice(0, 160),
  };
}

// ---- JSON-RPC over stdio -----------------------------------------------------

const codex = spawn(CODEX, ["app-server", "--stdio"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stderrBuf = "";
codex.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

const pending = new Map();
let nextId = 1;

const rl = createInterface({ input: codex.stdout });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    codex.stdin.write(payload);
  });
}

const notify = (method, params) =>
  codex.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the probe ---------------------------------------------------------------

const report = {
  codex: CODEX,
  version: null,
  cwd: CWD,
  steps: [],
  errors: [],
};

function record(step, detail) {
  report.steps.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[probe] ${step}: ${JSON.stringify(detail)}`);
}

try {
  report.version = execFileSync(CODEX, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
} catch (e) {
  report.errors.push(`version: ${e.message}`);
}

try {
  record("before", { proxies: [] });

  const init = await rpc("initialize", {
    clientInfo: { name: "opencadre-probe", title: "OpenCadre probe", version: "0.0.1" },
    capabilities: {},
  });
  record("initialize", { result: init });
  notify("initialized", {});

  const beforeStart = snapshotProxies();
  record("proxies_before_thread_start", {
    total: beforeStart.length,
    proxies: beforeStart.map(describe),
  });

  // --- thread #1
  const t1 = await rpc("thread/start", { cwd: CWD });
  const thread1 = t1?.thread?.id ?? t1?.threadId ?? null;
  record("thread_start_1", { threadId: thread1, raw: t1 });

  await sleep(3000); // let any stdio MCP children appear
  const afterT1 = snapshotProxies();
  const childT1 = descendantsOf(codex.pid, afterT1);
  record("after_thread_1", {
    total_all: afterT1.length,
    descendants_of_appserver: childT1.map(describe),
  });

  // --- thread #2
  const t2 = await rpc("thread/start", { cwd: CWD });
  const thread2 = t2?.thread?.id ?? t2?.threadId ?? null;
  record("thread_start_2", { threadId: thread2, raw: t2 });

  await sleep(3000);
  const afterT2 = snapshotProxies();
  const childT2 = descendantsOf(codex.pid, afterT2);
  record("after_thread_2", {
    total_all: afterT2.length,
    descendants_of_appserver: childT2.map(describe),
  });

  // --- verdict
  const pids1 = new Set(childT1.map((p) => p.ProcessId));
  const pids2 = new Set(childT2.map((p) => p.ProcessId));
  const shared = [...pids1].filter((p) => pids2.has(p));
  const onlyNew = [...pids2].filter((p) => !pids1.has(p));

  report.verdict = {
    distinct_threads: thread1 !== null && thread2 !== null && thread1 !== thread2,
    child_procs_after_thread_1: pids1.size,
    child_procs_after_thread_2: pids2.size,
    pids_shared_between_both: shared,
    pids_appearing_only_at_thread_2: onlyNew,
    // The question: does a second chat launch a second proxy, or does it reuse one?
    second_chat_spawned_new_proxy: onlyNew.length > 0,
    two_chats_share_one_proxy: shared.length > 0 && onlyNew.length === 0,
  };
  console.log("\n[probe] VERDICT");
  console.log(JSON.stringify(report.verdict, null, 2));
} catch (e) {
  report.errors.push(e.message);
  console.error("[probe] ERROR", e.message);
} finally {
  try {
    codex.stdin.end();
  } catch {}
  await sleep(500);
  try {
    codex.kill();
  } catch {}
  if (stderrBuf.trim()) {
    report.stderr = stderrBuf.slice(0, 4000);
  }
  console.log("\n[probe] full report");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length ? 1 : 0);
}