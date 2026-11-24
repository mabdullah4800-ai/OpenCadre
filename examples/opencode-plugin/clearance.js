// OpenCode v2 clearance adapter. The installed OpenCadre gate remains the policy authority:
// its shell rules, hub policy/cache, project opt-in, billing behavior and approval wait live there.
// This module only translates OpenCode's permission.evaluate call into a PreToolUse request.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

// The injectable default: a direct call whose options always end in windowsHide: true, so the child opens no console
// window on Windows whatever the caller passes. A raw child_process function is never handed around (see
// tests/product-spawn-static-guard.test.ts).
function hiddenSpawn(command, args, options) {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

// The gate beside this plugin's folder when there is one (installed: bin/.gen/<id>/opencadre-approval-gate.mjs, the
// plugin's own generation, so a long-lived OpenCode keeps the gate it loaded with; a legacy root install: the root
// entry, as before), else the install root's entry stub (a checkout, where examples/ holds no gate).
const SIBLING_GATE = fileURLToPath(new URL("../opencadre-approval-gate.mjs", import.meta.url));
// A damaged installed generation must keep its pinned path: runGate then denies its load failure.
// Only checkout execution may use the machine's root entry.
const PLUGIN_PARENT = dirname(dirname(fileURLToPath(import.meta.url)));
const IN_GENERATION = basename(dirname(PLUGIN_PARENT)) === ".gen" && /^[0-9a-f]{12}$/.test(basename(PLUGIN_PARENT));
const DEFAULT_GATE = () => (IN_GENERATION || existsSync(SIBLING_GATE) ? SIBLING_GATE : join(process.env.OPENCADRE_HOOK_HOME || homedir(), ".opencadre", "bin", "opencadre-approval-gate.mjs"));
const MAX_OUTPUT = 64 * 1024;
const GATE_TIMEOUT_MS = 590_000;
const activeChildren = new Set();
process.once("exit", () => { for (const child of activeChildren) { try { child.kill(); } catch { /* exiting */ } } });

// The helper reads the same three config layers. A longer configured approval wait needs a longer
// parent deadline, or OpenCode would kill the helper while a human's approval is still pending.
export function gateTimeoutFor(cwd) {
  let waitSeconds = 540;
  for (const path of [join(homedir(), ".opencadre", "approval-gate.json"),
    ...(typeof cwd === "string" && cwd ? [join(cwd, ".opencadre", "approval-gate.json")] : []),
    ...(process.env.OPENCADRE_GATE_CONFIG ? [resolvePath(cwd || process.cwd(), process.env.OPENCADRE_GATE_CONFIG)] : [])]) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"))?.waitSeconds;
      if (value !== undefined) waitSeconds = Number(value);
    } catch { /* Absent or malformed layers are ignored by the helper too. */ }
  }
  if (process.env.OPENCADRE_APPROVAL_WAIT) waitSeconds = Number(process.env.OPENCADRE_APPROVAL_WAIT);
  return Number.isFinite(waitSeconds) && waitSeconds > 0
    ? Math.max(GATE_TIMEOUT_MS, (waitSeconds + 50) * 1000) : GATE_TIMEOUT_MS;
}

export async function runGate({
  command, sessionID, cwd, gatePath = DEFAULT_GATE(), nodePath = "node",
  timeoutMs = gateTimeoutFor(cwd), spawnImpl = hiddenSpawn, env = process.env,
}) {
  if (typeof command !== "string" || !command || typeof sessionID !== "string" || !sessionID || !cwd) {
    return { decision: "deny", reason: "OpenCadre cannot identify this command's chat and project." };
  }
  return new Promise((resolve) => {
    let child;
    let timer;
    let done = false;
    let output = "";
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stopChild = () => { try { child?.kill(); } catch { /* already exited */ } };
    try {
      child = spawnImpl(nodePath, [gatePath, "--client", "opencode"], {
        cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      return finish({ decision: "deny", reason: "OpenCadre clearance helper could not start." });
    }
    if (!child?.stdout || !child?.stderr || !child?.stdin) {
      stopChild();
      return finish({ decision: "deny", reason: "OpenCadre clearance helper could not start." });
    }
    activeChildren.add(child);
    timer = setTimeout(() => {
      stopChild();
      finish({ decision: "deny", reason: "OpenCadre clearance helper timed out." });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) {
        stopChild();
        finish({ decision: "deny", reason: "OpenCadre clearance helper returned too much output." });
      }
    });
    child.stderr.on("data", () => { /* Never echo stderr: it may include local paths. */ });
    child.stdin.on("error", () => { stopChild(); finish({ decision: "deny", reason: "OpenCadre clearance helper input failed." }); });
    child.on("error", () => { activeChildren.delete(child); finish({ decision: "deny", reason: "OpenCadre clearance helper could not start." }); });
    child.on("close", (code) => {
      activeChildren.delete(child);
      if (done) return;
      if (code !== 0) return finish({ decision: "deny", reason: "OpenCadre clearance helper failed." });
      if (!output.trim()) return finish({ decision: "pass" });
      try {
        const result = JSON.parse(output).hookSpecificOutput;
        if (result?.hookEventName !== "PreToolUse" || !["allow", "deny"].includes(result.permissionDecision)) {
          return finish({ decision: "deny", reason: "OpenCadre clearance helper returned an invalid decision." });
        }
        // F7 / Q1f: an allow counts only with a person (or a person's standing grant) behind it. The gate prints no
        // other allow; one without provenance (a gate older than this adapter, whose onTimeout / onHubUnreachable
        // "allow" still printed one) is no opinion, so OpenCode's own permission settings still decide.
        if (result.permissionDecision === "allow" && !["person", "grant"].includes(result.opencadreProvenance)) {
          return finish({ decision: "pass" });
        }
        return finish({ decision: result.permissionDecision, reason: result.permissionDecisionReason });
      } catch {
        return finish({ decision: "deny", reason: "OpenCadre clearance helper returned invalid JSON." });
      }
    });
    try {
      child.stdin.end(JSON.stringify({ session_id: sessionID, cwd, tool_input: { command } }));
    } catch {
      stopChild();
      finish({ decision: "deny", reason: "OpenCadre clearance helper input failed." });
    }
  });
}
async function sessionDirectory(ctx, sessionID) {
  if (typeof sessionID !== "string" || !sessionID || typeof ctx.session?.get !== "function") return null;
  try {
    const session = await ctx.session.get({ sessionID });
    const directory = session?.data?.location?.directory ?? session?.location?.directory;
    return typeof directory === "string" && directory ? directory : null;
  } catch {
    return null;
  }
}

const registrations = new WeakMap();
const CALL_EXPIRY_MS = 60_000;
const DECISION_EXPIRY_MS = 30_000;
// OpenCode sets the plugin up once per location in one process. Its hooks can all see the same tool call;
// a process-wide record keeps the full command and one in-flight/settled approval for that call.
const calls = () => (globalThis.__opencadreOpenCodeClearance ??= new Map());
const callKey = (sessionID, id) =>
  typeof sessionID === "string" && sessionID && typeof id === "string" && id ? `${sessionID}\0${id}` : null;
const evictLater = (key, record, ms) => {
  clearTimeout(record.timer);
  record.timer = setTimeout(() => { if (calls().get(key) === record) calls().delete(key); }, ms);
  record.timer.unref?.();
};

function recordShellCall(event) {
  if (event?.tool !== "shell") return;
  const key = callKey(event.sessionID, event.id);
  if (!key) return;
  const command = event.input?.command;
  const workdir = event.input?.workdir;
  if (typeof command !== "string" || !command.trim()) return;
  const saved = calls().get(key);
  if (saved) {
    // Different project plugin instances must agree on the same tool input for this id.
    if (saved.command !== command || saved.workdir !== workdir) saved.invalid = true;
    return;
  }
  const record = { command, workdir, invalid: workdir !== undefined && typeof workdir !== "string", decision: null, timer: null };
  calls().set(key, record);
  evictLater(key, record, CALL_EXPIRY_MS); // A native OpenCode denial never invokes evaluate.
}

/** Register the full-command capture and blocking permission hook once per plugin context. */
export function registerClearance(ctx, { gate = runGate } = {}) {
  if (registrations.has(ctx)) return registrations.get(ctx);
  // Register the denial path first. If the capture hook fails to register, every shell call still
  // lacks a full-command record and is refused rather than running with only scanner fragments.
  const permission = ctx.permission.hook("evaluate", async (event) => {
    if (event?.action !== "shell" || event.effect === "deny") return;
    const deny = (reason) => {
      event.effect = "deny";
      event.message = reason;
    };
    if (!Array.isArray(event.resources) || event.resources.length === 0
      || event.resources.some((c) => typeof c !== "string" || !c)) {
      deny("OpenCadre could not read the shell command.");
      return;
    }
    const key = callKey(event.sessionID, event.source?.id);
    const record = key && calls().get(key);
    if (!record || record.invalid) {
      deny("OpenCadre could not verify this shell call's full command, so it was blocked.");
      return;
    }
    if (!record.decision) {
      clearTimeout(record.timer);
      record.decision = (async () => {
        const directory = await sessionDirectory(ctx, event.sessionID);
        if (!directory) return { decision: "deny", reason: "OpenCadre could not identify this chat's project directory." };
        const cwd = record.workdir ? resolvePath(directory, record.workdir) : directory;
        try {
          return await gate({ command: record.command, sessionID: event.sessionID, cwd });
        } catch {
          return { decision: "deny", reason: "OpenCadre clearance helper failed." };
        }
      })();
      record.decision.then(() => evictLater(key, record, DECISION_EXPIRY_MS),
        () => evictLater(key, record, DECISION_EXPIRY_MS));
    }
    const result = await record.decision;
    if (result?.decision === "deny") {
      deny(result.reason || "OpenCadre denied this command.");
    } else if (result?.decision === "allow") {
      // Only a person's approval or a person's standing grant reaches here (runGate turns any other allow into "pass").
      // A policy fallback (onTimeout / onHubUnreachable "allow") is no opinion and sets no effect (F7 / Q1f).
      event.effect = "allow";
    } else if (result?.decision !== "pass") {
      deny("OpenCadre clearance helper returned no valid decision.");
    }
  });
  const capture = ctx.tool.hook("execute.before", recordShellCall);
  const ready = Promise.all([permission, capture]);
  registrations.set(ctx, ready);
  return ready;
}
