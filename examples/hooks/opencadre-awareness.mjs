#!/usr/bin/env node
// OpenCadre session hook for Claude Code, Codex and Cursor. Zero dependencies; run it from this
// repo checkout (it imports scripts/pure-ack.mjs). Each harness names these events its own way and
// reads its answers in its own shape; scripts/opencadre-hook-dialect.mjs translates both, so this
// script is written once against Claude Code's names (Cursor: sessionStart, beforeSubmitPrompt,
// postToolUse, stop).
//
//   SessionStart      Every start, resume, clear and compact: tells the session WHO it is
//                     (GET /v1/me) and the fleet protocol, then the digest if anything happened.
//   UserPromptSubmit  Injects the awareness digest, only when something P1 or P2 happened.
//   PostToolUse       Same, throttled per session.
//   Stop              Peeks the inbox. Real mail waiting blocks the stop once, so the agent
//                     answers instead of going idle. Low priority and pure acks never block.
//
// Any failure is silent (SessionStart instead warns that identity is unverified):
// the hook never blocks work because the hub is slow or down.
//
// One exception, and it is deliberate: a payload from a harness this copy was not installed for (Cursor
// loads Claude Code's hooks), or with no session_id at all, is not this client's session, so the hook
// declines to act. A non-Claude harness loading these hooks (Cursor, Grok) would otherwise act as this
// machine's Claude identity. See docs/design/HOOK-NOOP-RESEARCH.md.
//
// Install: node scripts/install-session-hooks.mjs --client codex|claude-code
//
// The hub and key come from OPENCADRE_URL + OPENCADRE_KEY, else from the client's own MCP
// config (~/.codex/config.toml, ~/.claude.json), so a session needs no extra setup. --client
// reads only that client's config, so a machine running both clients keeps each identity;
// without it Codex's config is tried, then Claude Code's (scripts/opencadre-config.mjs).
// On a connected machine (~/.opencadre/credentials.json) with no named agent for the folder, the
// hook acts as this session's own agent (hook input session_id), and tells the session its name once the
// session exists. For most clients that request is resolve-only and the MCP proxy creates the session; for a
// stamp client (one whose chats carry a signed session stamp, such as Codex or Cursor) the hook's request may
// create the session itself (scripts/opencadre-config.mjs resolveHub, ownSeat). In a project the workspace
// hasn't enabled (403 project_not_enabled) it exits 0 with no output at all.
//
// Environment:
//   OPENCADRE_URL, OPENCADRE_KEY           hub URL and this agent's agt_ key (optional, see above)
//   OPENCADRE_HOOK_HOME                     home directory holding the client configs (default: ~)
//   OPENCADRE_AWARENESS_MIN_INTERVAL        seconds between PostToolUse checks per session (default 60)
//   OPENCADRE_AWARENESS_STATE_DIR           where the per-session throttle file lives (default: OS temp dir)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAmbiguousSession, isBillingReadOnly, isProjectNotEnabled, NO_SESSION_ERROR, codexWakeInstalled, resolveHub, scopedSessionId } from "../../scripts/opencadre-config.mjs";
import { isPureAck } from "../../scripts/pure-ack.mjs";
import { parseHookInput, contextOutput, dialectFor, followupOutput, foreignHost, hookCwd, hookEvent, hookSessionId, silenceFor } from "../../scripts/opencadre-hook-dialect.mjs";
import { hostHandoffFor, toolPrefixFor } from "../../scripts/opencadre-clients.mjs";

const HANDLED = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
const PREVIEW_CHARS = 120;
const MAX_PREVIEWS = 5;
const WAKE_SCRIPT = fileURLToPath(new URL("../../scripts/opencadre-wake.mjs", import.meta.url));

// Injected on every SessionStart: this is what onboards a new session without a human.
const PROTOCOL = `Fleet protocol:
- If that is not the agent you expect, stop fleet calls and tell the operator (sessions sharing a key read each other's mail). Work only in your own working directory/worktree.
- Call get_active_agents, then set_status (task, files) now and on each task change.
- Reply on-thread to all mail except pure acknowledgements: reply on threads, send_message for new topics, priority:"low" for routine updates.
- Never put a key (agt_/org_/dev_, even partially) in any message, status, file, PR or commit; keys live only in client config.
- Act on mail and tasks the moment they arrive; never wait for a human to say continue.
- Decide yourself (record_decision if non-obvious). Missing info? Ask another agent and keep working.
- Involve a human only for credentials, payments, spending, publishing, approving a risky clearance, changing another agent's access (keys, roles, kill switch), or a decision the operator reserved: request_approval, then do other work.
- Code: branch, PR, review by another agent matching the change's risk, merge after approval, confirm the hash, add a regression test.
- Checkpoints: get_awareness, then ack_event what you handled.
- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`;

// Cursor has no way to wake an idle chat (no API submits a prompt to an open one), so a Cursor chat is told
// the truth about when mail reaches it rather than to keep a watcher it cannot be woken by.
const CURSOR_STANDBY = `- In Cursor, OpenCadre's tools are named opencadre_<tool>: opencadre_set_status, opencadre_get_messages, opencadre_reply, and so on.
- When you are waiting for a teammate's reply that blocks your task, one opencadre_wait_for_message with timeoutSeconds: 280 is fine.
- New mail reaches you when your turn ends and while you use tools. Cursor cannot wake an idle chat, so before you stop, check opencadre_get_messages if you are expecting an answer.`;

// Gemini CLI has no async hooks and no API to prompt an idle session: same truth, its own words.
const GEMINI_STANDBY = `- When you are waiting for a teammate's reply that blocks your task, one wait_for_message with timeoutSeconds: 280 is fine.
- New mail reaches you when your turn ends and while you use tools. Gemini CLI cannot wake an idle session, so before you stop, check get_messages if you are expecting an answer.`;

// Qwen Code: its async hooks can add context but cannot start a turn, so it cannot be woken either.
const QWEN_STANDBY = GEMINI_STANDBY.replace("Gemini CLI cannot wake an idle session", "Qwen Code cannot wake an idle session");
// Copilot CLI: agentStop can keep a turn going, nothing starts one in an idle session.
const COPILOT_STANDBY = GEMINI_STANDBY.replace("Gemini CLI cannot wake an idle session", "Copilot CLI cannot wake an idle session");

const protocolFor = (client) => client === "cursor"
  ? PROTOCOL.replace(`- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`, CURSOR_STANDBY)
  : client === "gemini"
  ? PROTOCOL.replace(`- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`, GEMINI_STANDBY)
  : client === "qwen"
  ? PROTOCOL.replace(`- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`, QWEN_STANDBY)
  : client === "copilot"
  ? PROTOCOL.replace(`- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`, COPILOT_STANDBY)
  : client === "codex" && codexWakeInstalled()
  ? PROTOCOL.replace(`- If finished background tasks wake you, keep node "${WAKE_SCRIPT}" running as one.`,
    `- When you are waiting for a teammate's reply that blocks your task, one wait_for_message with timeoutSeconds: 280 is fine. If your client runs it in a code cell, wait on that cell with a matching long yield, not 30 s repeats.
- When you are just standing by, end your turn: OpenCadre wakes this chat when mail arrives, immediately for urgent mail.`)
  : PROTOCOL;

// --client reads only that client's MCP config, so a machine running both clients keeps each identity.
const cliArgs = process.argv.slice(2);
const client = cliArgs.includes("--client") ? cliArgs[cliArgs.indexOf("--client") + 1] : ["codex", "claude-code"];

class CleanExit extends Error {}
// "No opinion" is an empty stdout for Claude Code and Codex, and `{}` for Cursor (which logs an empty
// answer as a failed hook run).
const silent = () => {
  const quiet = silenceFor(client);
  if (quiet) process.stdout.write(quiet);
  throw new CleanExit();
};
const emit = (text) => {
  process.stdout.write(text);
  throw new CleanExit();
};
const inject = (event, text) => emit(contextOutput(client, event, text));

async function main() {
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = parseHookInput(raw);
} catch {
  silent();
}

// Installed for one harness, running inside another: Cursor runs Claude Code's hooks by default, and its
// payloads now carry a session_id (the chat's conversation_id), so the guard below no longer catches them.
// The copy installed FOR Cursor handles a Cursor chat; this one stays out.
const host = foreignHost(client, input);
if (host) {
  process.stderr.write(`opencadre-awareness: this payload came from ${host}, not ${[client].flat().join("/")}; not acting.\n`);
  // In the HOST's "no opinion": Cursor logs an empty answer as a failed hook run on every event.
  const quiet = silenceFor(host);
  if (quiet) process.stdout.write(quiet);
  throw new CleanExit();
}
// The canonical (Claude Code) name for this harness's event, or null for one we do not handle.
const event = hookEvent(client, input);
if (!HANDLED.has(event)) silent();
// A tool whose call the gate may deny, where the harness drops a hook's context (Crush's bash): nothing said there.
if (dialectFor(client).awarenessSkipsTools?.includes(input?.tool_name)) silent();
// A Stop hook already continued this turn: stopping now is what prevents a loop. (Grok also says it in camelCase.)
if (event === "Stop" && (input.stop_hook_active || input.stopHookActive)) silent();
// Grok also fires Stop as the session ends (`shutdown`, `channel_closed`): nothing is left to continue. Only its
// end-of-turn Stop is a turn to extend.
const turnEnd = dialectFor(client).stopTurnReason;
if (event === "Stop" && turnEnd && typeof input.reason === "string" && input.reason !== turnEnd) silent();
// Cursor's stop says how the turn ended; a turn the user aborted, or one that errored, is not a turn to extend. And
// its `loop_count` is Claude Code's stop_hook_active: a stop that a follow-up already continued is let go.
if (event === "Stop" && dialectFor(client).output === "cursor") {
  if (typeof input.status === "string" && input.status !== "completed") silent();
  if (Number(input.loop_count) > 0) silent();
}

// A harness we do not serve gets here by loading these hooks anyway -- Cursor and Grok both read Claude
// Code's hooks by default -- and its payload carries no session_id. Acting would be worse than silence:
// resolveHub would fall back to CLAUDE_CODE_SESSION_ID from the environment, so a Cursor or Grok chat
// impersonated a live Claude Code session and answered its mail.
//
// The test is one field: `session_id`, present-and-non-null. That is exactly the contract, not an
// approximation of it. Both served clients guarantee it and both foreign ones cannot produce it:
//
//   claude-code  sends session_id by definition of the field.
//   codex        PUBLISHED SCHEMA REQUIRES IT. Both hook-event schemas declare
//                "additionalProperties": false with session_id in `required`, type "string", NOT
//                nullable -- github.com/openai/codex codex-rs/hooks/schema/generated, fetched
//                2026-09-18.
//   cursor       base payload is conversation_id/generation_id/hook_event_name/model/... and, since
//                at least 2026.09.23, ALSO session_id (= conversation_id) -- so a Cursor payload is now
//                caught by the foreign-host guard above rather than by this one.
//   grok         BOTH sessionId and session_id (measured on 1.0.41; #259 predates that).
//
// Codex is safe here STRUCTURALLY, which is stronger than the schema argument and worth stating
// because it cannot be re-opened by a vendor change: the client table declares codex
// `sessionIdSource: { from: "process" }`, and resolveSessionId returns `${name}-${randomUUID()}`
// for `from: "process"` at scripts/opencadre-config.mjs:251 -- BEFORE it ever reads an env var at
// :258. So codex cannot reach CLAUDE_CODE_SESSION_ID through this path whatever any schema says.
// Verified: with CLAUDE_CODE_SESSION_ID set, codex still resolves to a fresh codex-<uuid>.
//
// Do NOT widen this to accept other id keys. Accepting conversation_id would let a Cursor chat claim
// this machine's Claude identity -- the exact bug this guard exists to stop. It was tried and reverted;
// see the commit history for this branch and docs/design/HOOK-NOOP-RESEARCH.md.
//
// This guard matches a contract the repo had already stated: the pre-existing test
// `without a session id there is no identity` (tests/awareness-hook.test.ts) already asserted that an
// empty session_id means no identity and nothing is created. So this is a clarification of an
// existing boundary, not a new refusal -- the hook was previously inconsistent with its own tests.
//
// This is a decided no-op, not a silent one. The failure it guards is invisible by nature -- a wrong
// identity answers mail confidently and nothing reports it -- so one line on stderr is the only cheap
// signal that the collision happened.
// hookSessionId is used ONLY for a client whose host changes its session under the hooks (Qwen, `hostHandoff`), so
// the guard above keeps its meaning for every other client: a payload `session_id`, and nothing else, names a chat.
// A dialect that names the session in a field of its own (Copilot's `sessionId`) reads that field, and only that one.
const sessionField = dialectFor(client).sessionField;
const sessionId = hostHandoffFor(client) ? hookSessionId(input, client)
  : typeof input.session_id === "string" ? scopedSessionId(client, input.session_id)
  : sessionField && typeof input[sessionField] === "string" ? input[sessionField]
  // A dialect that names it deeper in the payload (Cline's `sessionContext.rootSessionId`), that field only.
  : typeof dialectFor(client).sessionOf?.(input) === "string" ? dialectFor(client).sessionOf(input) || undefined : undefined;
if (!sessionId) {
  process.stderr.write(
    `opencadre-awareness: no session_id in this payload (hook_event_name=${event}); not acting. ` +
    `A harness we do not serve is loading these hooks (see docs/design/CROSS-HARNESS-INHERITANCE.md).\n`,
  );
  silent();
}

const stateDir = process.env.OPENCADRE_AWARENESS_STATE_DIR || tmpdir();
// Past the guard this is always this session's own id -- never a shared "default" that would make two
// chats collide on one throttle file.
const sessionTag = String(sessionId).replace(/[^\w.-]/g, "_");
// A harness whose start and prompt hooks cannot answer (Cline runs them detached) is told its name at its first tool
// result instead (`introOnTool` in its dialect row).
const introEvent = dialectFor(client).introOnTool ? "PostToolUse" : "UserPromptSubmit";
// The PostToolUse digest is checked at most once per interval per session; this file holds the last check.
const throttleFile = join(stateDir, `opencadre-awareness-${sessionTag}.json`);
const throttled = () => {
  const interval = Number(process.env.OPENCADRE_AWARENESS_MIN_INTERVAL ?? 60) * 1000;
  let last = 0;
  try {
    last = JSON.parse(readFileSync(throttleFile, "utf8")).lastCheck ?? 0;
  } catch { /* first check in this session */ }
  return Date.now() - last < interval;
};
// Most PostToolUse calls are inside the interval and end silent whatever the hub lookup says, so they end here, before
// resolveHub (it reads the client's MCP config, credentials and the project list: about 9 ms). The output is the same
// silence either way. Not where PostToolUse also tells a session its name (introOnTool): that comes before the throttle.
if (event === "PostToolUse" && introEvent !== "PostToolUse" && throttled()) silent();

// A named agent for the folder wins; else this machine's device credential acts for THIS session (session_id). Device
// requests are resolve-only (a desktop helper process has no MCP proxy, so no session is created for it), except for a
// stamp client (one whose chats carry a signed session stamp, such as Codex or Cursor): its hook may create this chat's
// own session, since a hook only fires inside a real chat (scripts/opencadre-config.mjs resolveHub, ownSeat).
const { base, key, source, headers = {} } = resolveHub({ client, cwd: hookCwd(input), sessionId });
if (!base || !key) silent();
// A device session's identity is told once: at SessionStart when the session already exists, else at the first prompt.
const announcedFile = join(stateDir, `opencadre-identity-${sessionTag}.json`);
const announced = () => {
  try {
    return Boolean(JSON.parse(readFileSync(announcedFile, "utf8")).at);
  } catch {
    return false;
  }
};
const markAnnounced = () => {
  if (source !== "device") return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(announcedFile, JSON.stringify({ at: Date.now() }));
  } catch { /* worst case the name is told again */ }
};

// Refusal state only, NEVER cached identity. Bind to this credential, project and chat.
const retryTag = createHash("sha256").update(JSON.stringify([base, key, client, sessionId, hookCwd(input)])).digest("hex");
const identityRetryFile = join(stateDir, "opencadre-identity-retry-" + retryTag + ".json");
const readIdentityRetry = () => {
  try {
    const value = JSON.parse(readFileSync(identityRetryFile, "utf8"));
    return value.kind === "capacity" || (value.kind === "throttle" && Number.isFinite(value.retryAt)) ? value : null;
  } catch { return null; }
};
const writeIdentityRetry = (value) => {
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(identityRetryFile, JSON.stringify(value)); }
  catch { /* best effort availability control, never authentication */ }
};
const retryAtFor = (res, body) => {
  const now = Date.now(), raw = res.headers.get("retry-after");
  if (raw !== null && raw.trim()) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0 && Number.isSafeInteger(now + seconds * 1000)) return now + seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  const seconds = body?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(now + seconds * 1000)
    ? now + seconds * 1000 : now + 60_000;
};
const retryText = (retry) => retry.kind === "capacity"
  ? "OpenCadre: could not verify this session's identity (HTTP 429: device session capacity reached); do not send fleet messages. This is not proof of a bad key. Ask the operator for supported session-capacity recovery; do not reconnect, remove the shared device, or retry automatically."
  : "OpenCadre: could not verify this session's identity (HTTP 429: temporarily throttled); do not send fleet messages until a fresh identity check succeeds. Retry-After is respected; the next prompt can recheck after the cooldown. This is not proof of a bad key.";

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${key}`, ...headers },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The hub has no session for this chat yet: not an error to report, just nobody to be.
    const noSession = source === "device" && res.status === 401 && body?.error === NO_SESSION_ERROR;
    // The workspace hasn't enabled this project: OpenCadre isn't here, so the hook ends at once and says nothing.
    if (source === "device" && isProjectNotEnabled(res.status, body)) silent();
    // A lapsed bill is not a broken identity (LAUNCH-CLIENT-GATE.md §1 row 5: hooks go quiet). A chat whose first
    // hook would CREATE its seat (a stamped Codex or Cursor chat) meets the hub's 402 on that creation, and must not
    // be told its identity could not be verified and to stop fleet work.
    if (isBillingReadOnly(res.status, body)) silent();
    // THE ONE REFUSAL THAT IS NEVER SILENT (508d, decision #13378). This chat's tool gave it no id its own proxy
    // could see, so the hub offered it the single live session in this project by deduction -- and there was more
    // than one. Staying quiet is what the no-session case does, and for THIS case quiet is the whole bug: the
    // session would look healthy while sending nothing and reading nothing, and a chat that guessed instead would
    // answer its sibling's mail under its sibling's name.
    const ambiguous = source === "device" && isAmbiguousSession(res.status, body);
    const tooManySessions = res.status === 429 && (body?.code === "too_many_sessions"
      || body?.error === "this device has too many live sessions; idle ones end on their own, or an operator can remove the device");
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, noSession, ambiguous, tooManySessions,
      retryAt: res.status === 429 && !tooManySessions ? retryAtFor(res, body) : undefined });
  }
  return res.json();
}

/** Said on SessionStart and on the first prompt, in the chat, whenever the hub refused to choose for this chat.
 * It names no agent on purpose: naming a candidate would be the guess the hub just declined to make.
 *
 * "START A FRESH CHAT HERE" WAS REMOVED 2026-09-21, and it was the worst line in the file: a fresh chat
 * mints a NEW session row on the same device, so the remedy ENLARGED the set that caused the refusal.
 * A chat told to do that complied, got refused again, and made the next attempt likelier to fail -- an
 * in-product instruction that compounds its own defect. The replacement names the two things that
 * actually reduce the count (close a sibling; have an operator end a session in the console's
 * sessions view, which lists every live session on the device) and stops telling the reader to add one. */
const AMBIGUITY_TEXT =
  "OpenCadre: this chat has no identity of its own. More than one live OpenCadre session is open in this project on " +
  "this machine, so the hub will not guess which one is you — and it will not guess silently. Close the other chat, " +
  "or have an operator end a session from the console's sessions view, which lists every live session on this " +
  "device. Do NOT start another chat to work around this: a new chat adds another live session to the same " +
  "project and makes this refusal more likely, not less. Until then do not send fleet messages as any of them.";

// The advisory uses no credential and cannot alter identity or clearance. Run only at startup
// and safe awareness checkpoints; its machine-level six-hour throttle avoids per-tool network reads.
//
// LOADED LAZILY, AND ONLY HERE (PR-E1, addendum §3.3). A static import of the notice module made its load failure (a
// syntax error, a missing sibling, a bad future edit) fail this whole hook, so a chat lost its identity text over an
// advisory. The literal relative specifier keeps the load inside this hook's own generation (the install rewrites
// ../../scripts/ to ./), and build.json `imports` counts dynamic imports, so the generation still requires the file.
// The catch covers ONLY the advisory: its load and its two calls. Identity, digest and Stop never pass through it.
let advisoryLoad;
const advisory = () => (advisoryLoad ??= import("../../scripts/opencadre-update-notice.mjs").catch((err) => {
  process.stderr.write(`opencadre-awareness: the update notice could not load (${err?.code ?? err?.name ?? "error"}); identity is unaffected.\n`);
  return null;
}));
const updateText = async () => {
  const mod = await advisory();
  if (!mod) return "";
  const [text] = await Promise.all([
    Promise.resolve().then(() => mod.connectorUpdateNotice({ base, stateDir, entryUrl: import.meta.url })).catch(() => ""),
    source === "device" ? Promise.resolve().then(() => mod.reportConnectorBuild({ base, credential: key, client, stateDir, entryUrl: import.meta.url })).catch(() => null) : null,
  ]);
  return typeof text === "string" ? text : "";
};
const withUpdate = async (text) => [text, await updateText()].filter(Boolean).join("\n\n");

const identityText = async (me) =>
  [`You are ${me.agentName} in the OpenCadre fleet "${me.orgName}".`, protocolFor(client), await goalText(), await digestText({ board: true })].filter(Boolean).join("\n\n");

// Unlike the digest (only what changed since last checkpoint), the goal is told every SessionStart
// unconditionally: a session that joins after the goal was set would otherwise never learn it just
// by reading "what's new," since nothing changed for it.
async function goalText() {
  try {
    // `goal` is this chat's goal: its project's while projects are kept apart, else the workspace's. `workspaceGoal`
    // comes only when both exist, so each is labelled for what it is.
    const { goal, workspaceGoal } = await get("/v1/goal");
    if (!goal) return "";
    if (!workspaceGoal) return `Current fleet goal (set by ${goal.set_by_agent_name}): ${goal.text}`;
    return `Current project goal (set by ${goal.set_by_agent_name}): ${goal.text}\nWorkspace goal (set by ${workspaceGoal.set_by_agent_name}): ${workspaceGoal.text}`;
  } catch (err) {
    if (err instanceof CleanExit) throw err;
    return "";
  }
}

// `board`: also the caller's own slice of the work board (NOW, the NEXT it could claim, its HELD, its WIP cap), printed
// even when nothing happened: a session starting work needs it. Only identityText asks for it, so the board is told at
// SessionStart (and a device chat's first prompt) and never on its own as a prompt, tool or Stop wake.
async function digestText({ board = false } = {}) {
  try {
    // ?board=1 only for identityText: the hub builds the board only when asked, and a prompt or tool check never asks.
    const digest = await get(board ? "/v1/awareness?board=1" : "/v1/awareness");
    const events = Array.isArray(digest.items) && digest.items.length > 0 && digest.text ? digest.text : "";
    const boardText = board && typeof digest.board?.text === "string" ? digest.board.text : "";
    return [events, boardText].filter(Boolean).join("\n\n");
  } catch (err) {
    if (err instanceof CleanExit) throw err;
    return "";
  }
}

const pendingIdentity = readIdentityRetry();
// Capacity has no promised recovery interval. Prompts, tools and Stop must not create retry traffic.
// Explicit SessionStart can recheck after separately supported capacity recovery.
if (pendingIdentity?.kind === "capacity" && event !== "SessionStart") silent();
if (pendingIdentity?.kind === "throttle" && Date.now() < pendingIdentity.retryAt) {
  if (event === "SessionStart") inject(event, retryText(pendingIdentity));
  silent();
}
const refuseIdentity = async (err) => {
  if (err.status === 429) {
    const retry = err.tooManySessions ? { kind: "capacity" } : { kind: "throttle", retryAt: err.retryAt };
    writeIdentityRetry(retry);
    // No update/goal/digest metadata after a refused identity request.
    inject(event, retryText(retry));
  }
  writeIdentityRetry({});
  const reason = err.status ? `HTTP ${err.status}` : "hub unreachable";
  inject(event, await withUpdate(`OpenCadre: could not verify this session's identity (${reason}); do not send fleet messages until the operator fixes the key.`));
};

if (event === "SessionStart") {
  let me;
  try {
    // For a device session this is the session's own agent, found (never created) from its session headers.
    me = await get("/v1/me");
  } catch (err) {
    if (err instanceof CleanExit) throw err;
    if (err.ambiguous) inject(event, await withUpdate(AMBIGUITY_TEXT));
    // No session yet (a helper process, or a chat whose proxy hasn't started): say nothing; the first prompt tries again.
    if (err.noSession) { const update = await updateText(); if (update) inject(event, update); silent(); }
    await refuseIdentity(err);
  }
  const text = await withUpdate(await identityText(me));
  writeIdentityRetry({});
  markAnnounced();
  inject(event, text);
}

if (event === introEvent && ((source === "device" && !announced()) || pendingIdentity?.kind === "throttle")) {
  try {
    const me = await get("/v1/me");
    const text = await withUpdate(await identityText(me));
    writeIdentityRetry({});
    markAnnounced();
    inject(event, text);
  } catch (err) {
    if (err instanceof CleanExit) throw err;
    // The refusal the session must hear about: it has no name and the hub will not pick one for it.
    if (err.ambiguous) inject(event, await withUpdate(AMBIGUITY_TEXT));
    if (err.status === 429 || pendingIdentity?.kind === "throttle") await refuseIdentity(err);
    // Still no session (or the hub is down): fall through to the digest, which is silent in that case too.
  }
}

if (event === "Stop") {
  try {
    const { messages } = await get("/v1/messages?peek=true");
    const real = (Array.isArray(messages) ? messages : []).filter((m) => m.priority !== "low" && (m.awaiting_reply || !isPureAck(m.body)));
    if (real.length === 0) silent();
    // A harness with no stop_hook_active (Goose) would be stopped again for the same mail at every turn end, up to its
    // cap: remember what this session was already stopped for, and stop again only for mail it has not been told of.
    if (dialectFor(client).stopGuard) {
      // In OpenCadre's own folder, not the shared temp one: the file decides what mail a session is told of.
      const toldDir = join(process.env.OPENCADRE_HOOK_HOME || homedir(), ".opencadre", "state");
      const toldFile = join(toldDir, `stop-told-${[client].flat()[0]}-${sessionTag}.json`);
      let told = [];
      try {
        told = JSON.parse(readFileSync(toldFile, "utf8")).ids ?? [];
      } catch { /* none yet */ }
      if (real.every((m) => told.includes(m.id))) silent();
      try {
        mkdirSync(toldDir, { recursive: true, mode: 0o700 });
        writeFileSync(toldFile, JSON.stringify({ ids: [...new Set([...told, ...real.map((m) => m.id)])].slice(-200) }), { mode: 0o600 });
      } catch { /* at worst the same mail is announced once more */ }
    }
    // The async Codex watcher skips only THESE exact ids, which this hook is about to deliver.
    // A missing handoff makes an extra wake; it can never hide mail that arrived after this peek.
    if (client === "codex") {
      try {
        const tag = createHash("sha256").update(`${key}\n${sessionId}`).digest("hex").slice(0, 16);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, `opencadre-stop-delivered-${tag}.json`), JSON.stringify({ ids: real.map((m) => m.id) }));
      } catch { /* watcher will wake conservatively if the handoff cannot be written */ }
    }
    // Previews only: the agent reads full bodies via get_messages, so repeating them here costs tokens twice.
    const preview = (s) => (s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s).replace(/\s+/g, " ");
    const lines = real.slice(0, MAX_PREVIEWS).map((m) => `- [${m.priority}] from ${m.from_agent_name}: ${preview(m.body)}`);
    if (real.length > MAX_PREVIEWS) lines.push(`…and ${real.length - MAX_PREVIEWS} more`);
    emit(followupOutput(client, `You have ${real.length} unread OpenCadre message(s). Read them with ${toolPrefixFor([client].flat()[0])}get_messages, answer each on its thread, then you may stop.\n${lines.join("\n")}`));
  } catch (err) {
    if (err instanceof CleanExit) throw err;
    silent();
  }
}

if (event === "PostToolUse") {
  // Read again here: the early check above is skipped for introOnTool, and another hook may have checked since.
  if (throttled()) silent();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(throttleFile, JSON.stringify({ lastCheck: Date.now() }));
  } catch { /* throttling is best-effort */ }
}

const digest = await withUpdate(await digestText());
if (digest) inject(event, digest);
}

try {
  await main();
} catch (err) {
  if (err instanceof CleanExit) {
    process.exitCode = 0;
  } else {
    throw err;
  }
}
