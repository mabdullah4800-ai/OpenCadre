// OpenCadre for Kilo Code (the `kilo` CLI, an OpenCode fork). The plugin file Kilo loads (opencadre-kilo-plugin.js)
// only exports the function this module builds: Kilo calls EVERY function a plugin module exports as a plugin, so the
// helpers live here, beside it, and never in a plugin folder.
//
// Read in the @kilocode/cli-linux-x64 7.7.9 binary and MEASURED live against it (docs/research/HARNESS-ADAPTERS.md §3):
//   plugin      `fn(ctx)` with ctx { client (the v1 SDK, in-process), project, worktree, directory, $ }, one instance per
//               project directory per Kilo process; returns hooks. Loaded from a config `plugin: ["file:///…"]` entry.
//   tool.execute.before(input { tool, sessionID, callID }, output { args })
//               Changing a property of `output.args` reaches the call (replacing the object does NOT); throwing blocks
//               the call and the model is shown the message; the hook is awaited with no timeout.
//               MCP tools are `<server>_<tool>` (so ours are `opencadre-session_…`); the shell tool is `bash`
//               { command, workdir? }, and `background_process` { action: "start"|"monitor", command } runs one too.
//   event({ event })  session.created / session.updated { sessionID, info: { parentID? } }, session.status,
//               session.idle { sessionID }; not awaited, so nothing here may throw.
//   client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } }) starts a turn in an idle
//               session (204 in ~50 ms).
//   MCP         ONE child per project directory, shared by every session there, with no session id anywhere (not in its
//               environment, not in `_meta`). So each OpenCadre call is stamped with its session (the proxy refuses an
//               unstamped one), as for Codex and Amp.
//
// What it does:
//   Identity   stamps every OpenCadre call with its session's signed, dated stamp.
//   Clearance  runs the shared approval gate (--client kilo) on every shell command; a deny throws with the reason.
//   Mail       when a top-level session goes idle, peeks its inbox, and prompts it with ONE notice for real mail, now or
//              when it arrives (a long-poll while it stays idle). Subagents (a `parentID`) are never woken.
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

const OURS = /^opencadre-session_/;
const GATE = fileURLToPath(new URL("./opencadre-approval-gate.mjs", import.meta.url));
// Kilo runs plugins under Bun; the gate is a Node script like every other hook.
const NODE = process.versions.bun ? "node" : process.execPath;
const PREVIEW_CHARS = 120;
const MAX_PREVIEWS = 5;
const WAIT_SECONDS = 50;
const PEEK_TIMEOUT_MS = 5000;
const IDLE_WATCH_MS = 2 * 60 * 60 * 1000;
const MAX_NO_SESSION = 3;
const MAX_FAILURES = 20;

const real = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m?.priority !== "low" && (m.awaiting_reply || !isPureAck(m.body)));

/** The notice a session reads, in the words the other watchers use. */
export function notice(messages) {
  const preview = (s) => (String(s).length > PREVIEW_CHARS ? `${String(s).slice(0, PREVIEW_CHARS)}…` : String(s)).replace(/\s+/g, " ");
  const lines = messages.slice(0, MAX_PREVIEWS).map((m) => `- [${m.priority}] from ${m.from_agent_name}: ${preview(m.body)}`);
  if (messages.length > MAX_PREVIEWS) lines.push(`…and ${messages.length - MAX_PREVIEWS} more`);
  return `You have ${messages.length} unread OpenCadre message(s). Read them with get_messages, answer each on its thread, then carry on.\n${lines.join("\n")}`;
}

/** The shell command a Kilo tool call is about to run, or null. */
export function shellCommandOf(tool, args) {
  if (tool === "bash" && typeof args?.command === "string") return args.command;
  if (tool === "background_process" && (args?.action === "start" || args?.action === "monitor") && typeof args?.command === "string") return args.command;
  return null;
}

/** Runs the shared gate as Kilo's session: { decision: "deny", reason } or { decision: "pass" }. A gate that cannot run,
 * or answers nothing readable, DENIES: Kilo awaits this hook, and a clearance that failed must not become a pass. */
export function runGate({ command, workdir, sessionID, cwd, spawnImpl = hiddenSpawn, gatePath = GATE, env = process.env }) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    const fail = (err) => resolve({
      decision: "deny",
      reason: err?.code === "ENOENT"
        // Kilo runs under Bun; the gate needs Node, found on PATH (review of 91c617a, N7).
        ? "OpenCadre's approval gate could not run because `node` is not on this Kilo's PATH, so this command was blocked. Install Node.js, or start Kilo from a shell where `node` works."
        : "OpenCadre's approval gate could not run, so this command was blocked.",
    });
    try {
      child = spawnImpl(NODE, [gatePath, "--client", "kilo"], { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      return fail(err);
    }
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (code !== 0) return fail(null);
      if (!out.trim()) return resolve({ decision: "pass" });
      try {
        const said = JSON.parse(out).hookSpecificOutput;
        if (said?.permissionDecision === "deny") return resolve({ decision: "deny", reason: said.permissionDecisionReason || "OpenCadre denied this command." });
        if (said?.permissionDecision === "allow") return resolve({ decision: "pass" });
      } catch { /* unreadable */ }
      fail();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionID, cwd, tool_name: "Bash", tool_input: { command, ...(typeof workdir === "string" && workdir ? { workdir } : {}) } }));
  });
}

const pause = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** The plugin function, with its outside world injectable so it can be tested without Kilo. */
export function createKiloPlugin({ spawnImpl = hiddenSpawn, fetchImpl = (...a) => fetch(...a), env = process.env, now = () => Date.now(), waitSeconds = WAIT_SECONDS, retryMs = 1000 } = {}) {
  // One Kilo process may set this plugin up once per project directory; what it knows about a session is kept once.
  const shared = { sessions: new Map() };
  return async function OpenCadre(ctx) {
    const directory = typeof ctx?.directory === "string" && ctx.directory ? ctx.directory : process.cwd();
    const state = (id) => {
      let s = shared.sessions.get(id);
      if (!s) shared.sessions.set(id, (s = { parent: undefined, idle: false, lastActive: now(), afterId: null, announced: new Set(), gen: 0, controller: null, busy: 0 }));
      return s;
    };

    const identity = (sessionID) => {
      const hub = resolveHub({ client: "kilo", cwd: directory, sessionId: sessionID, env });
      if (!hub.base || !hub.key) return null;
      return { base: hub.base, headers: { authorization: `Bearer ${hub.key}`, ...hub.headers, [RESOLVE_ONLY_HEADER]: "1" } };
    };

    async function peek(sessionID, { wait = false, afterId = null, signal } = {}) {
      const id = identity(sessionID);
      if (!id) return { stop: true };
      const path = wait
        ? `/v1/messages/wait?peek=true&timeoutSeconds=${waitSeconds}${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ""}`
        : "/v1/messages?peek=true";
      const deadline = AbortSignal.timeout(wait ? (waitSeconds + 15) * 1000 : PEEK_TIMEOUT_MS);
      const res = await fetchImpl(`${id.base}${path}`, { headers: id.headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (isBillingReadOnly(res.status, body) || isProjectNotEnabled(res.status, body)) return { stop: true };
        return res.status === 401 ? { noSession: true } : { failed: res.status };
      }
      const { messages } = await res.json();
      return { messages: Array.isArray(messages) ? messages : [] };
    }

    const prompt = async (sessionID, text) => {
      await ctx.client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } });
    };

    /** Is this session a subagent? From the events seen, else asked of Kilo once. */
    async function isSubagent(sessionID) {
      const s = state(sessionID);
      if (s.parent === undefined) {
        try {
          const got = await ctx.client.session.get({ path: { id: sessionID } });
          s.parent = got?.data?.parentID ?? got?.parentID ?? null;
        } catch {
          s.parent = null;
        }
      }
      return Boolean(s.parent);
    }

    /** Watches an idle session until real mail arrives, then prompts it ONCE. A new call replaces an older loop. */
    async function watch(sessionID) {
      const s = state(sessionID);
      s.controller?.abort();
      const gen = ++s.gen;
      const controller = new AbortController();
      s.controller = controller;
      const current = () => s.gen === gen && !controller.signal.aborted;
      let noSession = 0;
      let failures = 0;
      try {
        while (current() && s.idle && now() - s.lastActive < IDLE_WATCH_MS) {
          let got;
          try {
            got = await peek(sessionID, { wait: true, afterId: s.afterId, signal: controller.signal });
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
          const fresh = real(got.messages).filter((m) => !s.announced.has(m.id));
          if (got.messages.length) s.afterId = got.messages.at(-1).id ?? s.afterId;
          if (fresh.length === 0) continue;
          for (const m of fresh) s.announced.add(m.id);
          s.idle = false; // the prompt starts a turn
          try {
            await prompt(sessionID, notice(fresh));
            break;
          } catch {
            for (const m of fresh) s.announced.delete(m.id);
            s.idle = true;
            if (++failures >= MAX_FAILURES) break;
            await pause(5 * retryMs, controller.signal);
          }
        }
      } finally {
        if (s.controller === controller) s.controller = null;
      }
    }

    return {
      "tool.execute.before": async (input, output) => {
        const sessionID = input?.sessionID;
        if (typeof sessionID !== "string" || !sessionID || !output?.args || typeof output.args !== "object") return;
        const s = state(sessionID);
        s.idle = false;
        s.busy++;
        s.lastActive = now();
        s.controller?.abort();
        if (typeof input.tool === "string" && OURS.test(input.tool)) {
          const cred = explainDeviceCredential({ client: "kilo", env }).credential;
          // Set IN PLACE: Kilo keeps using the object it passed, and ignores a replacement.
          if (cred?.credential) output.args[STAMP_FIELD] = mintStamp(cred.credential, sessionID, now());
          return;
        }
        const command = shellCommandOf(input.tool, output.args);
        if (!command) return;
        // The session's project, never the model-written `workdir`: the folder decides which clearance policy applies.
        // `workdir` goes along only for the branch check, which the gate reads where the command runs (review of 91c617a,
        // S1: `git reset --hard` with workdir in another repo's main branch was exempt by the project's feature branch).
        const verdict = await runGate({ command, workdir: typeof output.args.workdir === "string" ? output.args.workdir : undefined, sessionID, cwd: directory, spawnImpl, env });
        if (verdict.decision === "deny") throw new Error(verdict.reason);
      },
      event: async ({ event } = {}) => {
        try {
          const props = event?.properties ?? event ?? {};
          const sessionID = props.sessionID ?? props.info?.id;
          if (typeof sessionID !== "string" || !sessionID) return;
          if (event.type === "session.created" || event.type === "session.updated") {
            state(sessionID).parent = props.info?.parentID ?? null;
            return;
          }
          if (event.type === "session.status" && props.status?.type === "busy") {
            const s = state(sessionID);
            s.idle = false;
            s.busy++;
            s.lastActive = now();
            s.controller?.abort();
            return;
          }
          if (event.type !== "session.idle") return;
          const s = state(sessionID);
          // A turn that starts while this asks Kilo about the session wins: it is no longer idle (review of 91c617a, N1).
          const busy = s.busy;
          if (await isSubagent(sessionID)) return;
          if (s.busy !== busy) return;
          s.idle = true;
          s.lastActive = now();
          let got = {};
          try {
            got = await peek(sessionID);
          } catch { /* silent */ }
          if (got.stop || s.busy !== busy) return;
          const unread = Array.isArray(got.messages) ? got.messages : [];
          if (unread.length) s.afterId = unread.at(-1).id ?? s.afterId;
          const fresh = real(unread).filter((m) => !s.announced.has(m.id));
          if (fresh.length > 0) {
            for (const m of fresh) s.announced.add(m.id);
            s.idle = false;
            try {
              await prompt(sessionID, notice(fresh));
              return;
            } catch {
              for (const m of fresh) s.announced.delete(m.id);
              s.idle = true;
            }
          }
          void watch(sessionID);
        } catch { /* never throw into Kilo's event loop */ }
      },
    };
  };
}
