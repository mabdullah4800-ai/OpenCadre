#!/usr/bin/env node
// OpenCadre inbox hooks for Antigravity. Zero dependencies.
//
//   stop            Before the agent goes idle, peeks this agent's inbox. If mail is waiting it
//                   returns decision "continue", so the agent answers instead of stopping. Peek
//                   only: messages stay unread until the agent reads them itself. A stop caused by
//                   a quota or usage-limit error reports the agent as out of usage instead.
//   pre-invocation  Injects, as one ephemeral message and only when needed:
//                   - fleet identity + protocol on a NEW conversationId. A usage-limit model switch
//                     or a new chat starts a conversation that remembers nothing about the fleet.
//                   - a relaunch instruction when no wake watcher is running (at most every 5 min),
//                     because only the model can start it as a background task.
//                   - the awareness digest, when something P1 or P2 happened.
//                   It also reports usage restored after a limit, since running again proves it.
//                   Quiet turns add nothing to the context.
//
// Every failure prints {} and exits 0: the hooks never block Antigravity or keep it running
// because the hub is slow or down.
//
// hooks.json below ~/.gemini/config (commands run from the folder containing hooks.json, which for the
// global install is that config folder -- hence `workspacePaths`, not the process cwd, names the project):
//   { "opencadre-inbox": { "enabled": true,
//       "PreInvocation": [ { "type": "command", "command": "node path/to/opencadre-antigravity.mjs pre-invocation", "timeout": 10 } ],
//       "Stop":          [ { "type": "command", "command": "node path/to/opencadre-antigravity.mjs stop", "timeout": 10 } ] } }
//
// Environment:
//   OPENCADRE_URL, OPENCADRE_KEY    hub URL and this agent's agt_ key
//   OPENCADRE_HOOK_STATE_DIR        where the per-conversation loop guard lives (default: OS temp dir)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_SESSION_HEADER, resolveHub, SESSION_HEADER } from "../../scripts/opencadre-config.mjs";
import { hookCwd } from "../../scripts/opencadre-hook-dialect.mjs";

// Continues allowed on the same unread mail before the agent may stop anyway,
// e.g. when it cannot reach its MCP tools to read it.
const MAX_CONTINUES = 2;
const PREVIEW_CHARS = 120;
const MAX_PREVIEWS = 5;

// The watcher this hook tells the model to launch, named by THIS FILE's location rather than by any
// fixed path. installHelpers copies the hook into ~/.opencadre/bin/ and rewrites ../../scripts/ to ./,
// so the one expression resolves to `scripts/opencadre-wake.mjs` in a checkout and to the sibling
// `./opencadre-wake.mjs` once installed. A literal `scripts/opencadre-wake.mjs` would be wrong in every
// customer workspace, where there is no repo checkout to be relative to. opencadre-awareness.mjs uses
// the same expression for the same reason.
const WAKE_SCRIPT = fileURLToPath(new URL("../../scripts/opencadre-wake.mjs", import.meta.url));

const done = (output = {}) => {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
};

const mode = process.argv[2];
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch { /* treat unparseable input as empty */ }

// Antigravity hands this conversation's id to the hook on stdin, not through the environment, so it is
// passed to the resolver directly - the same way opencadre-wake.mjs and opencadre-awareness.mjs pass
// their harness's session id. Without it the resolver has no declared source for this client and returns
// no identity at all, which is why this hook was the one client whose chats could not be named.
//
// `headers` carries the session identity the resolver produced. Without forwarding it the hook would send
// only the machine credential, and the hub could not tell WHICH chat is calling - every per-session read
// would be attributed to the machine instead of this conversation. The sibling hooks forward it the same way.
//
// This resolves the hub ONCE for both modes, so wiring the id here gives `stop` and `pre-invocation` the
// same session identity: `stop` peeks THIS session's inbox, and `pre-invocation` names the new
// conversation. A usage-limit model switch starts a new conversationId, so it becomes a new agent - which
// is correct, and not a bug to "fix" later.
//
// `cwd` names the project, and it must be the workspace the model is working in, NOT this process's own
// folder. Antigravity runs a hook command from the folder holding hooks.json; for the global install
// connect writes that is ~/.gemini/config, which is no git checkout, so the default would resolve every
// session to `local:config`. The real workspace arrives in the payload as `workspacePaths`.
const { base, key, headers = {} } = resolveHub({
  client: "antigravity",
  // The IDE fills `workspacePaths`; the CLI sends none, and hookCwd then finds the conversation's folder by its id.
  cwd: hookCwd(input, undefined),
  sessionId: typeof input.conversationId === "string" ? input.conversationId : undefined,
});
if (!base || !key) done();

const PROTOCOL = [
  "Fleet protocol (full rules: the OpenCadre block in ~/.gemini/GEMINI.md; read it now if this conversation hasn't):",
  "- If that is not the agent you expect, stop fleet calls and tell the operator. Work only in your own folder.",
  "- set_status now and on every task change. Reply on-thread to every message except pure acknowledgements.",
  "- Never put a key (agt_/org_, even partially) in any message, status, file, PR or commit.",
  "- Act on mail and tasks the moment they arrive; never wait for a human to say continue.",
  "- Decide yourself (record_decision if non-obvious). Missing info? Ask another agent and keep working.",
  "- Involve a human only for credentials, payments, spending, publishing, approving a risky clearance, changing another agent's access (keys, roles, kill switch), or a decision the operator reserved: request_approval, then do other work.",
  "- Code: branch, PR, review by another agent matching the change's risk, merge after approval, confirm the hash, add a regression test.",
  `- Keep \`node "${WAKE_SCRIPT}"\` running as a background task; it wakes you when mail arrives.`,
].join("\n");
const WATCHER_NUDGE_MS = 5 * 60_000;
// Antigravity gives no usage numbers and no reset time, only the error that ended the turn.
const USAGE_LIMIT_ERROR = /quota|usage limit|rate limit|exhausted|credits/i;
const USAGE_STATE = "opencadre-antigravity-usage.json";

const stateDir = () => process.env.OPENCADRE_HOOK_STATE_DIR || tmpdir();
const readState = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), file), "utf8"));
  } catch {
    return fallback;
  }
};
const writeState = (file, value) => {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), file), JSON.stringify(value));
  } catch { /* best-effort: worst case the context repeats once */ }
};

// Mirrors scripts/opencadre-wake.mjs: its lock is named by key hash (plus, for a connected computer's conversation, its
// seat) and touched after every poll, so an old mtime or a dead pid means no watcher will wake this agent.
function watcherRunning() {
  const dir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre");
  const seat = headers[HOST_SESSION_HEADER] || headers[SESSION_HEADER];
  const file = join(dir, `wake-${createHash("sha256").update(seat ? `${key}\n${seat}` : key).digest("hex").slice(0, 16)}.lock`);
  try {
    if (Date.now() - statSync(file).mtimeMs > 2 * (70_000 + 30_000)) return false;
    const { pid } = JSON.parse(readFileSync(file, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function postUsage(limited) {
  const res = await fetch(`${base}/v1/usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...headers, "content-type": "application/json" },
    body: JSON.stringify({ limited, resetsAt: null, source: "antigravity" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeState(USAGE_STATE, { limited });
}

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${key}`, ...headers },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function shouldGiveUp(conversationId, pendingIds) {
  const dir = process.env.OPENCADRE_HOOK_STATE_DIR || tmpdir();
  const file = join(dir, `opencadre-antigravity-${String(conversationId || "default").replace(/[^\w.-]/g, "_")}.json`);
  const pending = pendingIds.sort().join(",");
  let state = { pending: "", continues: 0 };
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* first stop in this conversation */ }
  const continues = state.pending === pending ? state.continues + 1 : 1;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ pending, continues }));
  } catch { /* the guard is best-effort */ }
  return continues > MAX_CONTINUES;
}

try {
  if (mode === "stop") {
    if (input.error) {
      if (USAGE_LIMIT_ERROR.test(String(input.error))) await postUsage(true);
      done();
    }
    const { messages } = await get("/v1/messages?peek=true");
    if (!Array.isArray(messages) || messages.length === 0) done();
    if (shouldGiveUp(input.conversationId, messages.map((m) => m.id))) done();
    // Previews only: the agent reads full bodies via get_messages, so repeating them here costs tokens twice.
    const preview = (s) => (s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s).replace(/\s+/g, " ");
    const lines = messages.slice(0, MAX_PREVIEWS).map((m) => `- [${m.priority}] from ${m.from_agent_name}: ${preview(m.body)}`);
    if (messages.length > MAX_PREVIEWS) lines.push(`- …and ${messages.length - MAX_PREVIEWS} more`);
    done({
      decision: "continue",
      reason: `You have ${messages.length} unread OpenCadre message(s). Call get_messages, answer each on its thread, then you may stop.\n${lines.join("\n")}`,
    });
  }

  if (mode === "pre-invocation") {
    const parts = [];
    const conversation = String(input.conversationId || "default");

    // Kept in the state file until the hub has it, so a failed post is retried next turn.
    if (readState(USAGE_STATE, {}).limited) await postUsage(false).catch(() => {});

    const seen = readState("opencadre-antigravity-conversations.json", []);
    if (!seen.includes(conversation)) {
      writeState("opencadre-antigravity-conversations.json", [...seen, conversation].slice(-50));
      const me = await get("/v1/me").catch(() => null);
      parts.push(me
        ? `You are ${me.agentName} in the OpenCadre fleet "${me.orgName}".\n${PROTOCOL}`
        : "OpenCadre: could not verify this session's identity (hub unreachable or bad key); do not send fleet messages until the operator fixes it.");
    }

    if (!watcherRunning()) {
      const nudges = readState("opencadre-antigravity-watcher.json", {});
      if (Date.now() - (nudges[conversation] ?? 0) > WATCHER_NUDGE_MS) {
        writeState("opencadre-antigravity-watcher.json", { ...nudges, [conversation]: Date.now() });
        parts.push(`OpenCadre: your wake watcher is NOT running, so new mail cannot wake you. Launch \`node "${WAKE_SCRIPT}"\` as a BACKGROUND task now, before continuing.`);
      }
    }

    const digest = await get("/v1/awareness").catch(() => null);
    if (Array.isArray(digest?.items) && digest.items.length > 0 && digest.text) parts.push(digest.text);

    if (parts.length === 0) done();
    done({ injectSteps: [{ ephemeralMessage: parts.join("\n\n") }] });
  }
} catch { /* fall through: never block on hub errors */ }
done();
