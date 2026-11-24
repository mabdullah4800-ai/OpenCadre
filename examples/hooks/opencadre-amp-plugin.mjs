// OpenCadre plugin for Amp (ampcode.com). One long-lived plugin, loaded by Amp's CLI and editor from its user plugin
// folder ($XDG_CONFIG_HOME/amp/plugins, else ~/.config/amp/plugins), that gives every Amp thread its own OpenCadre
// identity, holds risky shell commands for approval, and brings new mail to a thread, including one that is idle.
//
// Built from Amp's plugin API reference (ampcode.com/manual/plugin-api and /docs/customize/plugins) and checked against
// the plugin host in @ampcode/cli 0.0.1790208065 (review of 597af1c); NOT yet measured in a signed-in Amp
// (docs/research/HARNESS-ADAPTERS.md §3):
//   tool.call   { tool, input, toolUseID, thread: { id } }; answers { action: "allow" } |
//               { action: "reject-and-continue", message } | { action: "modify", input } | { action: "synthesize", … }.
//               `modify` REPLACES the input; no answer is "allow". MCP tools are named `mcp__<server>__<tool>`, with the
//               server's hyphens turned into `_` (so ours arrive as `mcp__opencadre_session__…`).
//               `amp.helpers.shellCommandFromToolCall(event)` returns `{ command, dir? }` for a shell call (Bash, and
//               shell_command, which background jobs are renamed to), else null. A thrown handler becomes
//               `{ action: "error" }`, which stops the thread's worker, so nothing here throws.
//   agent.start { thread, message } / agent.end { thread, message, status: "done"|"error"|"cancelled" }; agent.end may
//               answer { action: "continue", userMessage, maxContinuations }, which Amp IGNORES once that many
//               plugin continuations have already happened in a row (any plugin's, not only ours).
//   amp.threads.get(id).appendUserMessage({ type: "user-message", content })   (async) puts a user message into a
//               thread from outside a handler: the one API in any harness here that can prompt an IDLE chat.
//   amp.system.workspaceRoot   a file URI of the workspace the user has open, or null; the project is read from it
//               (amp.helpers.filePathFromURI), never from a model-written `dir`.
//   One plugin process serves many threads at once, runs under Bun, and lives as long as Amp; `onDispose` runs on
//   unload, reload and a graceful shutdown. The host awaits every agent.end handler, so ours has a deadline.
//
// What it does, per job:
//   Identity   every OpenCadre MCP call gets a signed, dated stamp naming its THREAD (opencadre-config.mjs mintStamp),
//              and the proxy answers as that thread's agent. Amp's MCP server is one process for many threads.
//   Clearance  every shell command runs through the shared approval gate first (examples/hooks/
//              opencadre-approval-gate.mjs --client amp); a deny becomes reject-and-continue. Anything else is no
//              opinion, so Amp's own permissions still apply.
//   Mail       at the end of a turn the user started, unread mail continues it once; otherwise (our own continuation
//              ended, the continuation was not honoured, the thread went idle) a peek long-poll on the thread's inbox
//              appends ONE notice when real mail is waiting. A cancelled turn is never continued.
//
// Every failure is silent to the thread: a coordination aid must never break the tool it lives in.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { explainDeviceCredential, isBillingReadOnly, isProjectNotEnabled, mintStamp, RESOLVE_ONLY_HEADER, resolveHub, STAMP_FIELD } from "../../scripts/opencadre-config.mjs";
import { isPureAck } from "../../scripts/pure-ack.mjs";

// The injectable default: a direct call whose options always end in windowsHide: true, so the child opens no console
// window on Windows whatever the caller passes. A raw child_process function is never handed around (see
// tests/product-spawn-static-guard.test.ts).
function hiddenSpawn(command, args, options) {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

const OURS = /^mcp__opencadre[-_]session__/;
// Beside this file both in the repo (examples/hooks/) and once installed (~/.opencadre/bin/).
const GATE = fileURLToPath(new URL("./opencadre-approval-gate.mjs", import.meta.url));
// Amp runs plugins under Bun, so process.execPath is Bun's; the gate is a Node script like every other hook, and Node
// is on this machine because Amp starts OpenCadre's MCP server with it.
const NODE = process.versions.bun ? "node" : process.execPath;
const PREVIEW_CHARS = 120;
const MAX_PREVIEWS = 5;
const WAIT_SECONDS = 50;
// The turn-end peek must not hold the end of a turn on a hub that does not answer.
const PEEK_TIMEOUT_MS = 5000;
// A thread nobody has used for this long stops being watched: a long-poll keeps its agent marked online, and a thread
// the user left must not look alive (or be woken by mail) forever. Any later turn in it starts the watch again.
const IDLE_WATCH_MS = 2 * 60 * 60 * 1000;
// A thread whose agent does not exist yet (it never called an OpenCadre tool) cannot have mail: stop asking.
const MAX_NO_SESSION = 3;
const MAX_FAILURES = 20;
// How long the watcher lets a continuation we asked for start before it treats it as not honoured.
const CONTINUE_GRACE_MS = 3000;

const NOTICE_HEAD = /^You have \d+ unread OpenCadre message\(s\)\./;
const real = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m?.priority !== "low" && (m.awaiting_reply || !isPureAck(m.body)));

/** The notice a thread reads, in the words the Claude Code and Codex watchers use. Its first line is also how this
 * plugin recognises a turn it started itself (NOTICE_HEAD). */
export function notice(messages) {
  const preview = (s) => (String(s).length > PREVIEW_CHARS ? `${String(s).slice(0, PREVIEW_CHARS)}…` : String(s)).replace(/\s+/g, " ");
  const lines = messages.slice(0, MAX_PREVIEWS).map((m) => `- [${m.priority}] from ${m.from_agent_name}: ${preview(m.body)}`);
  if (messages.length > MAX_PREVIEWS) lines.push(`…and ${messages.length - MAX_PREVIEWS} more`);
  return `You have ${messages.length} unread OpenCadre message(s). Read them with get_messages, answer each on its thread, then carry on.\n${lines.join("\n")}`;
}

/** Runs the shared gate for one shell command, as Amp's thread: { decision: "deny", reason } or { decision: "pass" },
 * with `failed` when the gate could not run at all. */
export function runGate({ command, threadId, cwd, spawnImpl = hiddenSpawn, gatePath = GATE, env = process.env }) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawnImpl(NODE, [gatePath, "--client", "amp"], { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve({ decision: "pass", failed: true });
    }
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ decision: "pass", failed: true }));
    child.on("close", () => {
      try {
        const said = JSON.parse(out).hookSpecificOutput;
        if (said?.permissionDecision === "deny") return resolve({ decision: "deny", reason: said.permissionDecisionReason || "OpenCadre denied this command." });
      } catch { /* no answer is no opinion */ }
      resolve({ decision: "pass" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: threadId, cwd, tool_name: "Bash", tool_input: { command } }));
  });
}

/** A pause the watcher's abort ends early. */
const pause = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** The plugin, with its outside world injectable so it can be tested without Amp. */
export function createPlugin({ spawnImpl = hiddenSpawn, fetchImpl = (...a) => fetch(...a), env = process.env, now = () => Date.now(), waitSeconds = WAIT_SECONDS, retryMs = 1000, graceMs = CONTINUE_GRACE_MS } = {}) {
  return function opencadre(amp) {
    /** The folder the user has open in Amp, which names the project; the plugin's own cwd when Amp has none. */
    const cwd = () => {
      try {
        const root = amp.system?.workspaceRoot;
        if (root) return amp.helpers?.filePathFromURI ? amp.helpers.filePathFromURI(root) : fileURLToPath(String(root));
      } catch { /* fall through */ }
      return process.cwd();
    };
    let gateFailureLogged = false;
    const warn = (text) => {
      try {
        amp.logger?.warn?.(text);
      } catch { /* nowhere to say it */ }
    };

    // id -> { idle, lastActive, afterId, announced:Set, pending:{ ids }|null, gen, controller }
    const threads = new Map();
    const state = (id) => {
      let t = threads.get(id);
      if (!t) threads.set(id, (t = { idle: false, lastActive: now(), afterId: null, announced: new Set(), pending: null, gen: 0, controller: null }));
      return t;
    };
    /** Forgets threads nobody has used for longer than the watch window, so a long session does not grow without end. */
    const prune = () => {
      for (const [id, t] of threads) if (!t.controller && now() - t.lastActive > IDLE_WATCH_MS) threads.delete(id);
    };

    /** This thread's hub identity, resolve-only: nothing here ever creates an agent. */
    const identity = (threadId) => {
      const hub = resolveHub({ client: "amp", cwd: cwd(), sessionId: threadId, env });
      if (!hub.base || !hub.key) return null;
      return { base: hub.base, headers: { authorization: `Bearer ${hub.key}`, ...hub.headers, [RESOLVE_ONLY_HEADER]: "1" } };
    };

    async function peek(threadId, { wait = false, afterId = null, signal } = {}) {
      const id = identity(threadId);
      if (!id) return { stop: true };
      const path = wait
        ? `/v1/messages/wait?peek=true&timeoutSeconds=${waitSeconds}${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ""}`
        : "/v1/messages?peek=true";
      const deadline = AbortSignal.timeout(wait ? (waitSeconds + 15) * 1000 : PEEK_TIMEOUT_MS);
      const res = await fetchImpl(`${id.base}${path}`, { headers: id.headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (isBillingReadOnly(res.status, body) || isProjectNotEnabled(res.status, body)) return { stop: true };
        // Any other refusal (a 5xx, a rate limit) is a failure to back off from, never an empty inbox.
        return res.status === 401 ? { noSession: true } : { failed: res.status };
      }
      const { messages } = await res.json();
      return { messages: Array.isArray(messages) ? messages : [] };
    }

    /** Watches an idle thread's inbox until real mail arrives, then appends ONE notice. Each call starts a new
     * generation; an older loop sees it has been replaced and ends, so a turn that starts and ends inside a pause
     * never leaves the thread unwatched (review of 597af1c, S2). */
    async function watch(threadId, { delayMs = 0 } = {}) {
      const t = state(threadId);
      t.controller?.abort();
      const gen = ++t.gen;
      const controller = new AbortController();
      t.controller = controller;
      const current = () => t.gen === gen && !controller.signal.aborted;
      let noSession = 0;
      let failures = 0;
      try {
        if (delayMs) await pause(delayMs, controller.signal);
        // A continuation that did not start in time was not honoured: its mail is fair game for the watcher again.
        if (current() && t.pending) {
          for (const mid of t.pending.ids) t.announced.delete(mid);
          t.pending = null;
          t.afterId = null;
        }
        while (current() && t.idle && now() - t.lastActive < IDLE_WATCH_MS) {
          let got;
          try {
            got = await peek(threadId, { wait: true, afterId: t.afterId, signal: controller.signal });
          } catch {
            got = { failed: "network" };
          }
          if (!current()) break;
          if (got.failed) {
            if (++failures >= MAX_FAILURES) break;
            await pause(5 * retryMs, controller.signal);
            continue;
          }
          if (got.stop) break;
          if (got.noSession) {
            if (++noSession >= MAX_NO_SESSION) break;
            await pause(retryMs, controller.signal);
            continue;
          }
          noSession = 0;
          failures = 0;
          const fresh = real(got.messages).filter((m) => !t.announced.has(m.id));
          if (fresh.length === 0) {
            if (got.messages.length) t.afterId = got.messages.at(-1).id ?? t.afterId;
            continue;
          }
          for (const m of fresh) t.announced.add(m.id);
          t.idle = false; // the appended message starts a turn
          try {
            await amp.threads.get(threadId).appendUserMessage({ type: "user-message", content: notice(fresh) });
            if (got.messages.length) t.afterId = got.messages.at(-1).id ?? t.afterId;
            break;
          } catch {
            // Not delivered, so not announced: put it back and try again after a pause (review of 597af1c, S3).
            for (const m of fresh) t.announced.delete(m.id);
            t.idle = true;
            if (++failures >= MAX_FAILURES) break;
            await pause(5 * retryMs, controller.signal);
          }
        }
      } finally {
        if (t.controller === controller) t.controller = null;
      }
    }

    amp.on("tool.call", async (event) => {
      try {
        const threadId = event?.thread?.id;
        if (typeof threadId !== "string" || !threadId) return undefined;
        if (typeof event.tool === "string" && OURS.test(event.tool)) {
          const cred = explainDeviceCredential({ client: "amp", env }).credential;
          if (!cred?.credential) return undefined;
          // The whole input goes back with the stamp added LAST (a model-written field of the same name is replaced):
          // `modify` replaces the input, it does not merge.
          return { action: "modify", input: { ...(event.input ?? {}), [STAMP_FIELD]: mintStamp(cred.credential, threadId, now()) } };
        }
        const shell = amp.helpers?.shellCommandFromToolCall?.(event);
        if (typeof shell?.command !== "string" || !shell.command) return undefined;
        const verdict = await runGate({ command: shell.command, threadId, cwd: cwd(), spawnImpl, env });
        if (verdict.failed && !gateFailureLogged) {
          gateFailureLogged = true;
          warn("OpenCadre: the approval gate could not start (is `node` on PATH?), so shell commands are not held by OpenCadre.");
        }
        return verdict.decision === "deny" ? { action: "reject-and-continue", message: verdict.reason } : undefined;
      } catch {
        return undefined;
      }
    });

    amp.on("agent.start", (event) => {
      const id = event?.thread?.id;
      if (typeof id !== "string") return;
      const t = state(id);
      t.idle = false;
      t.lastActive = now();
      t.controller?.abort();
      // The continuation we asked for started: its mail is delivered. Any other turn means it was not honoured, and
      // that turn's end sees the mail again.
      if (t.pending) {
        if (!NOTICE_HEAD.test(String(event.message ?? ""))) for (const mid of t.pending.ids) t.announced.delete(mid);
        t.pending = null;
      }
    });

    amp.on("agent.end", async (event) => {
      const id = event?.thread?.id;
      if (typeof id !== "string") return undefined;
      const t = state(id);
      t.lastActive = now();
      prune();
      let got = {};
      try {
        got = await peek(id);
      } catch { /* silent */ }
      const unread = Array.isArray(got.messages) ? got.messages : [];
      const fresh = real(unread).filter((m) => !t.announced.has(m.id));
      // Continue only a turn the user started and finished. Stopping a turn (Esc) is the user's word, and a turn this
      // plugin started itself must not be continued again: Amp would ignore the second continuation in a row and the
      // mail would be lost (review of 597af1c, B1, S1). The watcher delivers after our own turns instead.
      const ours = NOTICE_HEAD.test(String(event.message ?? ""));
      if (event.status !== "done") {
        // Mail already waiting when the user stopped does not wake the thread; the next turn they start ends with it.
        // A turn that failed ("error") is left to the watcher, which delivers the mail as a new turn.
        if (event.status === "cancelled" && unread.length) t.afterId = unread.at(-1).id ?? t.afterId;
      } else if (fresh.length > 0 && !ours) {
        for (const m of fresh) t.announced.add(m.id);
        t.pending = { ids: fresh.map((m) => m.id) };
        if (unread.length) t.afterId = unread.at(-1).id ?? t.afterId;
        t.idle = true;
        // The fallback, should Amp not honour the continuation (another plugin's continuation already counted).
        void watch(id, { delayMs: graceMs });
        return { action: "continue", userMessage: notice(fresh), maxContinuations: 1 };
      }
      t.idle = true;
      if (!got.stop) void watch(id);
      return undefined;
    });

    amp.onDispose?.(() => {
      for (const t of threads.values()) t.controller?.abort();
    });
  };
}

export default createPlugin();
