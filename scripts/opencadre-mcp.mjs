#!/usr/bin/env node
// OpenCadre per-session MCP proxy (stdio). Zero dependencies, Node 20+.
//
// Each chat starts one of these (`opencadre connect --code ocd_…` registers it as the stdio server
// "opencadre-session" in every tool it sets up). Each JSON-RPC line from stdin is POSTed to <hub>/mcp
// with this computer's credential plus the headers naming the session and its project, so the hub
// answers as that session's own agent (created on first sight). Responses (JSON or SSE) go back to
// stdout one message per line.
//
//   node opencadre-mcp.mjs --client claude-code|codex
//
// The session:
//   - Claude Code: CLAUDE_CODE_SESSION_ID, kept across /clear by CLAUDE_CODE_HOST_SESSION_ID.
//   - Codex: a verified per-call hook stamp selects the chat's own channel (stampChannel below).
//     Without a stamp, the process fallback makes up a random id at start; that fallback id changes
//     with a new process. A matching stamped chat-proven seat can retain the hub agent, subject to
//     access and revival limits. Neither path proves that every real app restart changes the name,
//     or that a reopened chat will always supply its former identity and read its old mail.
//   - Cursor gives an MCP server no chat id and documents no process model, so each chat names itself on every call
//     through a signed stamp its preToolUse hook adds (opencadre-session-stamp.mjs --client cursor). An unstamped
//     tool call is refused; startup traffic asks the hub for no seat.
// The project: the git remote of the folder this runs in (X-OpenCadre-Project), see projectIdentity.
//
// Fails closed, never guessing an identity:
//   - a named OpenCadre agent applies to this folder (env key, project or user-wide `opencadre`
//     entry): it wins, so this server stays out of the way (initialize succeeds, no tools);
//   - no credential on this computer: every request gets a JSON-RPC error;
//   - Claude Code without CLAUDE_CODE_SESSION_ID: every request gets a JSON-RPC error, nothing reaches the hub;
//   - the project isn't enabled in the workspace (403 project_not_enabled): from then on this is an
//     empty server (no tools, one instructions line) and prints nothing, as if OpenCadre weren't here;
//   - any other hub error becomes a JSON-RPC error carrying the hub's message.
// stdout carries protocol messages only. Diagnostics go to stderr. The credential is never printed.
//
// Env: CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_HOST_SESSION_ID (set by Claude Code),
//      OPENCADRE_HOOK_HOME (home holding .opencadre and the tool configs, default ~)
import { CHAT_PROVEN_HEADER, clearHostHandoff, DEFER_SEAT_HEADER, SHARED_PROCESS_HEADER, explainDeviceCredential, folderAccess, heldSeats, hostFlags, isBillingReadOnly, locateHost, scopedSessionId, isProjectNotEnabled, PROJECT_HEADER, PROJECT_NAME_HEADER, resolveNamedAgent, resolveSessionId, sessionHeaders, stampActive, STAMP_FIELD, syncProjectAllowlist, verifyStamp, writeHostHandoff } from "./opencadre-config.mjs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { statSync } from "node:fs";
import { callMetaFor, callMetaRejectFor, hostHandoffFor, isStampless, initInstructionsFor, metaStampFor, pooledHostFor, sessionIdSourceFor, stampsFolder, toolPrefixFor } from "./opencadre-clients.mjs";

const args = process.argv.slice(2);
const client = args.includes("--client") ? args[args.indexOf("--client") + 1] : "claude-code";
// Cursor launches a project-configured stdio server from its own home. Pin the
// workspace before choosing an agent or opening a hub connection.
if (args.includes("--project")) {
  const project = args[args.indexOf("--project") + 1];
  if (client !== "cursor" || !project || !isAbsolute(project) || !statSync(project, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write("opencadre-mcp: invalid Cursor project path\n");
    process.exit(1);
  }
  process.chdir(project);
}
const CODEX = client === "codex";
// One process serving sessions in several folders, whose stamps sign each session's folder (the client row's
// `stampFolder`: Devin).
const SHARED_PROCESS = stampsFolder(client);
const SHUTDOWN_GRACE_MS = 2000;
const FALLBACK_PROTOCOL = "2025-06-18";

const NOT_CONNECTED = "OpenCadre isn't connected on this machine: run the connect command from the console.";

const diag = (text) => process.stderr.write(`opencadre-mcp: ${text}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const isRequest = (m) => m && typeof m === "object" && typeof m.method === "string" && m.id !== undefined && m.id !== null;
const rpcError = (id, message, code = -32000) => ({ jsonrpc: "2.0", id, error: { code, message } });

// --- Decide once, at start: this process serves one session in one folder --------------------

const named = resolveNamedAgent({ client, cwd: process.cwd() });
// explainDeviceCredential, not readDeviceCredential: same credential, plus WHY it was chosen.
// A machine entry that exists but is unusable falls back to an older per-tool entry BY DESIGN,
// and that used to happen silently - a corrupt credential degraded to a stale leftover with
// nothing said, so the agent kept working as an identity the operator believed was replaced.
// The fallback is correct; the silence was not. Reported here because this file owns a stderr
// and sits on the path where a broken credential actually reaches a user.
const deviceResolution = named.key ? null : explainDeviceCredential({ client });
const device = deviceResolution?.credential ?? null;
if (deviceResolution?.machineEntryUnusable) diag(deviceResolution.note);
// Where this client's session id comes from is declared in the canonical table, not branched on
// here. It used to be `CODEX ? codex-${randomUUID()} : process.env.CLAUDE_CODE_SESSION_ID`, which
// meant every new client needed a new branch in this file - the same drift the table removed.
const sessionSource = sessionIdSourceFor(client);
// The NAME of the `_meta` key a client sends its per-chat id under, when its source is "call". It
// is namespaced by the harness that owns it, and the MEASURED value (not the documented one) is
// what goes here: v2.0.10 sends `ai.opencode/sessionID`, while the docs show a bare `sessionID`.
// Keyed by client so a second per-call client adds a row rather than a branch below.
const CALL_META_KEYS = { opencode: ["ai.opencode/sessionID"] };
// The host process, for a client whose hooks find this child's seat through it (hostHandoff: Qwen). Found by walking
// this process's ancestry, never taken from the environment (review of e5f165e, B2).
const handoffSpec = device ? hostHandoffFor(client) : null;
const host = handoffSpec ? locateHost({ entryEnv: handoffSpec.entryEnv, pattern: handoffSpec.pattern }) : null;
// A host that cannot be identified might be one that pools sessions, so it is treated as one: FAIL CLOSED.
const HOST_UNKNOWN = Boolean(handoffSpec && !host);
const HOST_PID = host?.pid ?? null;
// A host that shares ONE child among many sessions (Qwen's ACP mode, read from its command line before any `--`).
// Such a child holds no seat: each call names its session in `_meta` (the table's `callMeta` path), and a call that
// names none is refused, since answering it on this process's seat would pool every session into one agent.
const pooledHost = pooledHostFor(client);
const acpFlag = (token) => pooledHost.flags.some((f) => token === f || (token.startsWith(`${f}=`) && !/=(false|0)$/i.test(token)));
const POOLED_HOST = Boolean(device && pooledHost && (HOST_UNKNOWN || hostFlags(host?.line, host?.argv).some(acpFlag)));
// A client that names the session on each call BESIDE its declared source (Goose's `_meta["agent-session-id"]`): a call
// that carries it acts as that session, whatever this process's variable says.
const rowCallMeta = callMetaFor(client);
const callMetaPath = sessionSource?.from === "call" ? CALL_META_KEYS[client] ?? null : POOLED_HOST ? pooledHost.callMeta : rowCallMeta;
const callMetaName = callMetaPath?.join(".") ?? null;
const POOLED_REFUSAL = HOST_UNKNOWN
  ? "OpenCadre: this call was not sent, because OpenCadre could not find the process that started it, so it cannot " +
    "tell that process's sessions apart. Restart the tool; if this keeps happening, run `opencadre doctor`."
  : "OpenCadre: this call did not say which session it belongs to, and this tool shares one OpenCadre connection among " +
    "all its sessions (an editor integration), so it was not sent. Use OpenCadre from the tool's own terminal session, " +
    "where each session is its own agent.";
// For a "call" client there is no id at start - the first `tools/call` carries it - so the startup
// resolution is expected to report ABSENT and is not an error. It becomes the refusal only if a
// request arrives that we cannot attribute (see callChannelFor).
const resolvedAtStart = resolveSessionId({ source: sessionSource });
// A client whose host changes the session variable under its hooks (Qwen, `hostHandoff`) records the seat this child
// holds, so the hooks name the agent the tool calls act as. A second host that resumed the SAME session (two
// `qwen --resume <id>`) gets its own seat, qualified by its pid, rather than sharing the first one's agent.
const scopedAtStart = resolvedAtStart.ok ? { ok: true, id: scopedSessionId(client, resolvedAtStart.id) } : resolvedAtStart;
const sessionAtStart = device && scopedAtStart.ok && host && !POOLED_HOST && heldSeats({ client, exceptHostPid: HOST_PID }).has(resolvedAtStart.id)
  ? { ok: true, id: `${resolvedAtStart.id.slice(0, 180)}~${HOST_PID}` }
  : scopedAtStart;
if (host && (POOLED_HOST || sessionAtStart.ok)) {
  writeHostHandoff({ client, hostPid: HOST_PID, seat: POOLED_HOST ? null : sessionAtStart.id, mode: POOLED_HOST ? "pooled" : "process" });
  process.on("exit", () => clearHostHandoff({ client, hostPid: HOST_PID }));
}
function buildHeaders(sessionId, hostSessionId, cwd = process.cwd()) {
  return sessionHeaders({
    client,
    sessionId,
    // The keeper variable is Claude Code's; it is meaningless for a client that synthesizes per
    // process, which the table already expresses by declaring "process" rather than "env".
    hostSessionId: sessionSource?.from === "env" && sessionSource.keeper
      ? process.env[sessionSource.keeper]
      : hostSessionId,
    cwd,
  });
}
// This process's own headers: its seat. A "call" client (OpenCode) never moves them; each chat id it sends travels on
// that chat's own channel instead (callChannelFor), so the seat stays the app-start one for id-less traffic.
let headers = device && sessionAtStart.ok ? buildHeaders(sessionAtStart.id) : null;

/**
 * Tell the hub a CHAT is behind this session, once there is proof.
 *
 * The hub cannot work this out for itself: `/mcp` receives headers and never the JSON-RPC method, so a
 * `tools/call` is invisible to it. This proxy sees the method, and a `tools/call` is the one signal an
 * eagerly-spawned phantom never produces — measured over every process in Codex's log, all four
 * phantoms had zero tool-call rows while 8 of 13 real chats had them (up to 2,537). The hub turns this
 * into `agents.liveness = 'chat'` (migration 38), which is what lets the console show chats as agents
 * and group the rest as background processes.
 *
 * Sent from the FIRST tool call onward and never withdrawn: the label is one-way, so a later request
 * that somehow lacked the header must not be able to demote a row. Set once, on the object the request
 * spreads, so every subsequent call carries it.
 *
 * The flag is remembered in `chatProven` and re-applied on every request, so it is a property of "this session has
 * proven a chat", not of one headers object. A chat's own channel (a Codex stamp, or an OpenCode call id; see
 * callChannelFor) carries the label from the start, since its first call is the proof.
 */
let chatProven = false;

/** Marks the session chat-proven. Called before every request goes out, so the promotion rides the
 * SAME call that proves the chat exists; re-applies the header after an adoption rebuild. */
function noteChatProven(body) {
  if (chatProven) {
    if (headers) headers[CHAT_PROVEN_HEADER] = "1"; // survive a rebuild
    return;
  }
  const call = (m) => !Array.isArray(m) && m?.method === "tools/call";
  if ((Array.isArray(body) ? body.some(call) : call(body)) && headers) {
    chatProven = true;
    headers[CHAT_PROVEN_HEADER] = "1";
  }
}

// A refusal is reported, not papered over. "absent" and "indeterminate" are different situations
// and say so; neither is allowed to become a shared or default identity.
//
// WORDING IS NUNT'S, NOT MINE (docs/design/UI_IDENTITY_FAILURES.md, strings 3a and 3b), used
// verbatim on their instruction through the supervisor. Their structure is deliberate and worth
// keeping intact when editing: line 1 states the state, line 2 is the ACTION, and only then the
// diagnosis. The action comes second because for most users it is the thing that actually works -
// the previous single message listed a speculative software upgrade FIRST and buried the remedy
// that bypasses the session-id mechanism entirely.
const SESSION_REFUSALS = {
  absent:
    "OpenCadre: this session has no id, so it has no identity.\n" +
    "Connect a named agent for this project instead - that does not need a session id.\n" +
    `(${client !== "claude-code" && sessionSource?.from === "env" ? `The tool normally supplies one in ${sessionSource.name}; it was not set.` : "Claude Code normally supplies one; if this is Claude Code, its session id was not set."})`,
  indeterminate:
    "OpenCadre: this session's id is not usable, so it has no identity.\n" +
    "It was set but is not a valid id (printable characters, no spaces, up to 200).\n" +
    "Connect a named agent for this project instead, or unset it to use the default.",
};
const NOT_ENABLED_INSTRUCTIONS = "OpenCadre isn't enabled for this project.";
const SESSION_NOT_ENABLED = "OpenCadre is not enabled for this session's project, so this call was not sent. The workspace owner can enable the project in the OpenCadre console.";

/** The credential (and anything shaped like one) never leaves in an error message. */
const redact = (text) => {
  let out = String(text);
  if (device?.credential) out = out.split(device.credential).join("[redacted]");
  return out.replace(/dev_[A-Za-z0-9]+/g, "dev_[redacted]");
};

/** Takes this chat's id off an incoming request, for a client whose table source is "call".
 *
 * WHY THIS EXISTS: OpenCode runs ONE MCP child for the whole app (measured, ppid is the service)
 * and never puts the chat id in the env or argv, so the only place it appears is
 * `params._meta["ai.opencode/sessionID"]` on a `tools/call`. A proxy that read its identity once at
 * spawn would therefore serve every chat as one agent - the fail-shared failure this area prevents.
 *
 * THE ID IS PER REQUEST, NOT PER CONNECTION, and that follows from the same measurement: because the
 * one child is shared, two chats talking in sequence send two different ids down the same stdin, and
 * each call must be answered under its OWN chat's id (measured: two ids in one process, two
 * adoptions, both calls answered - docs/design/HARNESS-OPENCODE-IDENTITY.md §3). So headers are
 * answered under that chat's own CHANNEL (the one stampChannel keeps for a Codex chat): its own headers AND its own
 * hub session, opened on first use. A call with no id (initialize, tools/list) goes out on the process's own state,
 * which at startup is the stable app-start seat resolveSessionId minted, so `initialize` still creates exactly one
 * row and serves a tool list before any chat id can arrive.
 *
 * WHY A CHANNEL AND NOT A HEADER REBUILD (2026-09-23): the first version rebuilt this process's global headers when
 * the id changed but kept the hub session `initialize` had opened as the app-start seat. The hub binds a session to
 * the agent that opened it and refuses any other (HTTP 401, "This API key doesn't match the agent this MCP session
 * belongs to"), so every tool call from an OpenCode chat failed, measured on v2.0.10 while OpenCode printed DONE.
 * Returns null (no id on any call), { channel }, or { refusal } for a batch naming two chats. */
function callChannelFor(body) {
  if (!callMetaPath || !device) return null;
  let channel = null;
  let unnamedCall = false;
  for (const m of Array.isArray(body) ? body : [body]) {
    // Only a tools/call can name a chat: an id on any other method is not the proof a chat is behind it.
    if (m?.method !== "tools/call") continue;
    const raw = callMetaPath.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), m.params?._meta);
    // Only an ABSENT key is unnamed. A key that is present but null is an unusable id, refused below like any other
    // (Codex-OpenCadre-8160 on 943e88a: null used to fall through to the app-start seat).
    if (raw === undefined) {
      unnamedCall = true;
      continue;
    }
    // A placeholder the client sends when it has no session is no identity at all (Droid's "unknown-session").
    if (callMetaRejectFor(client).includes(raw)) return { refusal: `OpenCadre: this call named no session (${callMetaName} was a placeholder), so it was not sent.` };
    const resolved = resolveSessionId({ sessionId: raw });
    // Present but unusable is INDETERMINATE, and it FAILS CLOSED: falling back to the app-start seat would act as a
    // different identity than the chat that sent it (Codex-OpenCadre-8160 on 557757c).
    if (!resolved.ok) return { refusal: `OpenCadre: this call's chat id (${callMetaName}) was unusable (${resolved.reason}), so it was not sent.` };
    const next = stampChannel(scopedSessionId(client, resolved.id));
    if (channel && channel !== next) return { refusal: "OpenCadre: one message named two different chats, so it was not sent." };
    channel = next;
  }
  // A batch goes out whole on ONE channel, so a named call beside an unnamed one would carry the unnamed call out as
  // the named chat. Neither can be sent honestly; the same rule as stampedChannelFor.
  if (channel && unnamedCall) return { refusal: "OpenCadre: one message mixed a chat's tool call with an unnamed one, so it was not sent." };
  return channel && { channel };
}

// --- Stamped chats: one CHANNEL per chat, never the process's own state -------------------------
//
// A Codex chat names itself through its hook's STAMP (examples/hooks/opencadre-session-stamp.mjs).
// Each stamped chat gets a CHANNEL: its own headers and its own hub MCP session. A stamped call carries
// its channel from here to the hub, and nothing about it is written to this process's globals.
//
// WHY NOT SWITCH THE GLOBALS (OpenCode's first version did, and every tool call failed; see callChannelFor): one Codex process can serve many
// chats (HARNESS-CODEX.md §5.4.3 measured one serving 138 threads). If a stamp moved the global
// headers, an UNSTAMPED call that came after would inherit the last chat's identity, and two chats'
// overlapping calls could leave on each other's headers or session. Both failures were found in review
// of the first version, and both are misattribution, the one thing this cell exists to prevent.
//
// ONE HUB SESSION PER CHAT because the hub binds an MCP session to the agent that opened it and refuses
// any other agent on it (src/mcp.ts routeMcpTransport, HTTP 401: "This API key doesn't match the agent
// this MCP session belongs to"). That check is right. So a chat's first stamped call opens the chat's
// own session with the client's original initialize, and every caller for that chat shares that one
// opening.
const stampChannels = new Map();

// `folder` is the session's own folder where the stamp signs one (mintStamp's `dir`: Devin, one process serving
// sessions in several folders). The chat's project is then that folder's, not this process's working directory, so its
// calls land in the same project as its gate and awareness (review of 47dab9a, B2).
function stampChannel(id, folder) {
  const key = folder ? `${id}\n${folder}` : id;
  let channel = stampChannels.get(key);
  if (!channel) {
    // Chat-proven from the start: a channel exists only because a stamped tools/call arrived, and that
    // call is the proof. The process's own seat is never labelled by it.
    channel = { id, headers: { ...buildHeaders(id, undefined, folder || process.cwd()), [CHAT_PROVEN_HEADER]: "1" }, session: undefined, opening: null };
    // That session's own folder, not this process's, decides whether it may reach the hub (local opt-in). Not sticky:
    // handleForward re-checks it after a list refresh, so a project enabled while this process runs reaches its chat.
    channel.folder = folder;
    if (folder && folderAccess({ cwd: folder, hub: device.hub, credential: device.credential }) === "unlisted") channel.notEnabled = true;
    stampChannels.set(key, channel);
  }
  return channel;
}

/** Takes a call's identity off its stamp.
 *
 * The field is REMOVED here, valid or not, so it never reaches the hub or the tool. A stamp that does not
 * verify REFUSES the call rather than falling back to this process's seat: an unverifiable identity is
 * not repaired into a default one. Returns null for a message with no stamp, which then travels exactly
 * as before (so a machine without the hook keeps today's behaviour), { channel } for a stamped one, or
 * { refusal } with the text to answer. */
// Copilot CLI signs the stamp into the request's `_meta` instead of its arguments (metaStampFor): its pre-call hook can
// replace `_meta` but only REPLACE a call's arguments, which would drop the model's.
const META_STAMP = metaStampFor(client);

function stampedChannelFor(body) {
  let channel = null;
  let unstampedCall = false;
  for (const m of Array.isArray(body) ? body : [body]) {
    const args = m?.method === "tools/call" ? m.params?.arguments : undefined;
    const meta = m?.method === "tools/call" ? m.params?._meta : undefined;
    const inArgs = Boolean(args && typeof args === "object" && Object.hasOwn(args, STAMP_FIELD));
    const inMeta = Boolean(META_STAMP && meta && typeof meta === "object" && Object.hasOwn(meta, META_STAMP));
    if (!inArgs && !inMeta) {
      if (m?.method === "tools/call") unstampedCall = true;
      continue;
    }
    // A client that never stamps (Droid names each call's session in `_meta`) has no business with one here.
    if (inArgs && isStampless(client)) {
      delete args[STAMP_FIELD];
      return { refusal: "OpenCadre: this call carried an identity stamp in its arguments, which this tool never sends, so it was not sent." };
    }
    const stamp = inArgs ? args[STAMP_FIELD] : meta[META_STAMP];
    // Removed wherever it rode, valid or not, so it never reaches the hub or the tool.
    if (inArgs) delete args[STAMP_FIELD];
    if (inMeta) delete meta[META_STAMP];
    const verified = verifyStamp(device?.credential, stamp);
    if (!verified.ok) return { refusal: `OpenCadre: this call's identity stamp did not verify (${verified.reason}), so it was not sent.` };
    const resolved = resolveSessionId({ sessionId: verified.sessionId });
    if (!resolved.ok) return { refusal: `OpenCadre: this call's identity stamp named an unusable session id (${resolved.reason}), so it was not sent.` };
    // A client whose stamp signs its folder (Devin) never sends one without: a stamp stripped of it would file the call
    // under this process's launch folder, another project (review of 3a79037, S3).
    if (SHARED_PROCESS && !verified.folder) return { refusal: "OpenCadre: this call's identity stamp named no folder, so it was not sent. Run the connect command again, then restart this tool." };
    const next = stampChannel(resolved.id, verified.folder);
    if (channel && channel !== next) return { refusal: "OpenCadre: one message carried two different chats' stamps, so it was not sent." };
    channel = next;
  }
  // A batch goes out whole on ONE channel, so a stamped call beside an unstamped one would carry the
  // unstamped call out as the stamped chat (review finding, d193 against d777d2d). Neither can be sent honestly.
  if (channel && unstampedCall) return { refusal: "OpenCadre: one message mixed stamped and unstamped tool calls, so it was not sent." };
  return channel && { channel };
}

/** The chat's hub session id, opening it on first use. Concurrent callers share one opening. */
function channelSession(channel) {
  if (channel.session) return Promise.resolve(channel.session);
  channel.opening ??= openSession(channel.headers, "took a chat's identity from its call (stamp or _meta); opened a hub session as that chat")
    .then((sid) => {
      channel.opening = null;
      channel.session = sid ?? undefined;
      return sid;
    });
  return channel.opening;
}

// --- Local answers when this server must not reach the hub ------------------------------------

/** A valid MCP server with no tools, for when this server must stay out of the way. */
const emptyServer = (instructions, whyNoMethod) => (message) => {
  if (!isRequest(message)) return;
  const { id, method, params } = message;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "opencadre-session", version: "0.1.0" },
        instructions,
      },
    });
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [] } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  send(rpcError(id, `Method not found: ${method}${whyNoMethod}`, -32601));
};

/** A named agent owns this folder. */
const answerStandDown = emptyServer(
  "A named OpenCadre agent is configured for this folder, so this session uses it (the opencadre server) and this server offers no tools.",
  " (a named OpenCadre agent is configured for this folder)",
);

/** The workspace hasn't enabled this project: no OpenCadre here at all. */
const answerNotEnabled = emptyServer(NOT_ENABLED_INSTRUCTIONS, "");

const answerError = (text) => (message) => {
  if (isRequest(message)) send(rpcError(message.id, text));
};

// --- Forwarding -------------------------------------------------------------------------------

let mcpSessionId;
let processOpening;
let protocolVersion;
/** In-flight requests by JSON-RPC id, so notifications/cancelled can end the matching HTTP request. */
const inflight = new Map();
const pending = new Set();

function requestIds(body) {
  return (Array.isArray(body) ? body : [body]).filter(isRequest).map((m) => m.id);
}

function failAll(body, text) {
  for (const id of requestIds(body)) send(rpcError(id, text));
}

function remember(message) {
  // The negotiated version goes on later requests, as a streamable HTTP client does.
  if (message && typeof message === "object" && typeof message.result?.protocolVersion === "string" && message.result.serverInfo) {
    protocolVersion = message.result.protocolVersion;
  }
}

// A client whose pre-tool hook sees a tool's name but not its server (Cursor) gets the hub's tools under a prefix, so
// its stamp hook can pick OpenCadre's calls out by name alone (opencadre-clients.mjs, toolPrefix). The prefix is added
// to every tool a tools/list answer names and removed from every tools/call before it leaves for the hub.
const TOOL_PREFIX = toolPrefixFor(client);

function prefixTools(message) {
  const tools = message?.result?.tools;
  if (!TOOL_PREFIX || !Array.isArray(tools)) return message;
  return { ...message, result: { ...message.result, tools: tools.map((t) => (t && typeof t.name === "string" ? { ...t, name: `${TOOL_PREFIX}${t.name}` } : t)) } };
}

/** Takes the prefix off a tools/call's name, in place. A name without it is left as it is: the hub then answers
 * it the way it answers any unknown tool. */
function unprefixCall(body) {
  if (!TOOL_PREFIX) return;
  for (const m of Array.isArray(body) ? body : [body]) {
    const name = m?.method === "tools/call" ? m.params?.name : undefined;
    if (typeof name === "string" && name.startsWith(TOOL_PREFIX)) m.params.name = name.slice(TOOL_PREFIX.length);
  }
}

// A session that no hook can brief (Goose: nothing a hook prints reaches the model at session start) learns the fleet
// protocol from the server's `instructions`, which Goose puts in its system prompt (review of d6a7ef7, S3). Added only
// where the hub's own answer has none, so a hub that sends instructions keeps its word.
const FLEET_INSTRUCTIONS = [
  "You are connected to OpenCadre, which coordinates this session with other AI coding agents and their human operator.",
  "Call get_awareness once to learn your agent name and what the others are doing, and set_status with a one-line task when you start or change work.",
  "When a turn ends, unread OpenCadre mail may be shown to you as a hook message: read it with get_messages and answer each on its thread with reply before stopping.",
  "Risky shell commands may be held until a person approves them; if one is denied, do not look for another way to do the same thing.",
  "Never put a key, password or token in a message, a task or a fact.",
].join(" ");

function emit(message) {
  remember(message);
  if (initInstructionsFor(client) && message?.result?.serverInfo && typeof message.result.protocolVersion === "string" && !message.result.instructions) {
    message = { ...message, result: { ...message.result, instructions: FLEET_INSTRUCTIONS } };
  }
  send(prefixTools(message));
}

/** Reads an SSE body and writes each event's data as one message. */
async function relaySse(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data.trim()) return;
    try {
      const parsed = JSON.parse(data);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m);
    } catch {
      diag("ignored an unparseable event from the hub");
    }
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const sep = buffer.slice(at).match(/^\r?\n\r?\n/)[0];
      flush(buffer.slice(0, at));
      buffer = buffer.slice(at + sep.length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

/** The client's own initialize request, kept so the hub session can be re-created after a hub restart. */
let initializeBody;

/**
 * A hub deploy forgets every MCP session, and from then on each call answered "MCP session not found
 * or expired (HTTP 404)" until the client itself was restarted (seen 2026-09-18). Re-create the
 * session with the client's original initialize, then the caller retries once.
 */
/** Opens a hub MCP session under `sessionHeaders` with the client's original initialize, and returns its
 * id (null if it could not). Takes the headers as an argument and writes no global, so a stamped chat's
 * session can be opened while other calls are in flight. */
async function openSession(sessionHeaders, why) {
  if (!initializeBody) return null;
  // A deploy can forget the session between initialize and its acknowledgement. Do not publish
  // that expired id to waiting callers; repeat this handshake once before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    let opened;
    const post = (payload) => fetch(`${device.hub}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${device.credential}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...sessionHeaders,
        ...(opened ? { "mcp-session-id": opened } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(payload),
    });
    try {
      const res = await post({ ...initializeBody, id: `reinit-${Date.now()}-${attempt}` });
      await res.text().catch(() => "");
      const sid = res.headers.get("mcp-session-id");
      if (!res.ok || !sid) return null;
      opened = sid;
      const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await ack.text().catch(() => "");
      if (ack.status === 404 && attempt === 0) continue;
      if (!ack.ok) return null;
      diag(why);
      return sid;
    } catch {
      return null;
    }
  }
  return null;
}

/** Opens this process's hub session once, even when several calls discover an expired session together. */
function processSession(why) {
  if (mcpSessionId) return Promise.resolve(mcpSessionId);
  processOpening ??= openSession(headers, why)
    .then((sid) => {
      if (sid) mcpSessionId = sid;
      return sid;
    })
    .finally(() => { processOpening = undefined; });
  return processOpening;
}

// THE PROCESS SEAT IS OPENED LAZILY once Codex trusts the stamp. Every Codex process used to join the roster at
// launch, because its initialize went out under this process's seat, so two chats listed as four agents
// (HARNESS-CODEX.md §6.2 run I2). With the stamp trusted, every chat names itself, so this process's own seat is
// needed only by an UNSTAMPED tool call: until one arrives, startup traffic asks the hub for no seat
// (DEFER_SEAT_HEADER), and the first one opens the seat with the client's own initialize. A hub that predates the
// header ignores it and mints a seat as before; its session id is then kept, which is exactly the old behaviour.
// Read once at start, like everything else about this process's identity.
//
// A `from: "stamp"` client (Cursor) defers ALWAYS, not only once the stamp is active: its process may serve
// many chats, so its own seat is never an identity any call may use (see STAMP_ONLY below). Startup traffic
// therefore never needs one.
const STAMP_ONLY = sessionSource?.from === "stamp";
// NOT deferred for a client whose calls also name their session (Goose, rowCallMeta): its hooks only ever look an
// agent up, so a seat opened at the first tool call left a session's risky commands unheld until the model happened
// to call OpenCadre (review of d6a7ef7, B1). Goose sets the variable to the session's own id for every extension it
// spawns for a session, so opening it at start names the right agent.
const deferProcessSeat = Boolean(device) && (STAMP_ONLY || POOLED_HOST || (client === "codex" && stampActive({ client })));
const UNSTAMPED_REFUSAL = client === "antigravity"
  ? "OpenCadre: Antigravity did not say which conversation this call belongs to (no antigravity.google/conversation_id), " +
    "so it was not sent: this server is shared by every conversation in the app. Update Antigravity, then restart it."
  // Devin Desktop's legacy Cascade conversations read Devin's MCP file but run none of its hooks, so connect cannot help
  // them (review of 47dab9a, N1). A project that redefines this server also leaves calls unstamped (the stamp hook).
  : client === "droid"
  ? "OpenCadre: Factory Droid did not say which session this call belongs to (no _meta.assemblySessionId), so it was " +
    "not sent: this server is shared by every Droid session. Update Droid, then start a new session."
  : client === "cursor"
  ? "OpenCadre: this call carried no identity stamp, so it was not sent. In Cursor, use the native MCP tool CallMcpTool or CallDynamicTool on the enabled opencadre-project server; do not run opencadre-mcp.mjs from a shell. Open the project folder in Cursor, select Opencadre Project for this chat, then call opencadre_get_active_agents."
  : client === "devin"
  ? "OpenCadre: this call carried no identity stamp, so it was not sent. OpenCadre works in the devin CLI and in Devin " +
    "Desktop's Devin Local tabs, whose hooks name each session; a Cascade conversation cannot. If this is a Devin Local " +
    "session, this project's .devin/mcp_config may define its own \"opencadre-session\" server, or run the connect command again."
  : "OpenCadre: this call carried no identity stamp, so it was not sent. Each chat names itself through " +
  `${client === "amp" ? "OpenCadre's Amp plugin" : client === "kilo" ? "OpenCadre's Kilo plugin" : "OpenCadre's pre-tool hook"}, and it did not run for this call. Run the connect ` +
  "command again, then restart this tool.";
const hasToolCall = (body) => (Array.isArray(body) ? body : [body]).some((m) => m?.method === "tools/call");

/** Sends one message to the hub. `channel` is a stamped chat's channel, whose headers and session are
 * used from start to finish; with none, the message goes out on this process's own state, as before. */
let nextBuildReportAt = 0;
// The build report's module is LOADED LAZILY, and only here (PR-E1, addendum §3.3). A static import made any load
// failure in the advisory module (a syntax error, a missing sibling, a bad future edit) fail this whole proxy, so the
// stub exited and the chat lost its OpenCadre identity over optional inventory. The literal relative specifier keeps the
// load inside this proxy's own generation, never the root stub's folder; build.json `imports` counts dynamic imports, so
// the generation still requires the file. The catch covers ONLY the report: its load and its call. Nothing on the
// identity path awaits it.
let advisoryLoad;
const advisory = () => (advisoryLoad ??= import("./opencadre-update-notice.mjs").catch((err) => {
  process.stderr.write(`opencadre-mcp: the build report module could not load (${err?.code ?? err?.name ?? "error"}); identity is unaffected.\n`);
  return null;
}));
function reportBuildAtCheckpoint() {
  const now = Date.now();
  if (!device || named.key || now < nextBuildReportAt) return;
  nextBuildReportAt = now + 6 * 3600_000;
  void advisory().then((mod) => mod?.reportConnectorBuild({ base: device.hub, credential: device.credential, client, component: "proxy",
    stateDir: process.env.OPENCADRE_AWARENESS_STATE_DIR || join(tmpdir(), "opencadre-build-reports"), entryUrl: import.meta.url })).catch(() => {});
}
async function forward(body, channel = null, retried = false) {
  if (body?.method === "initialize" || body?.method === "tools/call") reportBuildAtCheckpoint();
  if (!Array.isArray(body) && body?.method === "initialize") initializeBody = body;
  let seatless = false;
  if (!channel && deferProcessSeat && !mcpSessionId) {
    if (hasToolCall(body)) {
      // Opened through the hub's normal path, so its caps, billing and removed-seat checks all apply here. If it
      // cannot be opened, the call still goes out on that normal path, and the hub's refusal reaches the chat in its
      // own words rather than as "no session".
      await processSession("an unstamped tool call arrived; opened this process's own hub session");
    } else {
      seatless = true;
    }
  }
  // Before the request goes out, so the promotion rides the SAME call that proves the chat exists. A
  // stamped call proves ITS chat, whose channel already says so, and never labels this process's seat.
  if (!channel) noteChatProven(body);
  // A process that serves several folders (stampsFolder: Devin) says so on its seatless traffic, whose project (this
  // process's launch folder) is no session's (review of 47dab9a, B2).
  const requestHeaders = channel ? channel.headers : seatless ? { ...headers, [DEFER_SEAT_HEADER]: "1", ...(SHARED_PROCESS ? { [SHARED_PROCESS_HEADER]: "1" } : {}) } : headers;
  const requestSession = channel ? channel.session : mcpSessionId;
  const controller = new AbortController();
  const ids = requestIds(body);
  for (const id of ids) inflight.set(JSON.stringify(id), controller);
  try {
    const res = await fetch(`${device.hub}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${device.credential}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...requestHeaders,
        ...(requestSession ? { "mcp-session-id": requestSession } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    // A success can also arrive after another call reopened the session. Its old header must not
    // roll the channel back to the expired id, or the next call will start another recovery loop.
    if (sid && res.ok && (channel ? channel.session : mcpSessionId) === requestSession) {
      if (channel) channel.session = sid;
      else mcpSessionId = sid;
    }
    if (res.status === 404 && requestSession && !retried) {
      await res.text().catch(() => "");
      for (const id of ids) inflight.delete(JSON.stringify(id));
      if (channel) {
        // A later 404 still describes its original request, not a session another call just opened.
        if (channel.session === requestSession) channel.session = undefined;
        if (await channelSession(channel)) return forward(body, channel, true);
      } else {
        if (mcpSessionId === requestSession) mcpSessionId = undefined;
        if (await processSession("hub session expired (hub restarted?); re-initialized")) {
          return forward(body, null, true);
        }
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let hubSays = "";
      try {
        const parsed = JSON.parse(text);
        // Not enabled for this project: answer this and every later message locally, and say nothing about it.
        if (isProjectNotEnabled(res.status, parsed)) {
          // One process serving several folders: only THIS session's project is off, so only its calls are refused,
          // in words it can act on; the process's own traffic (an older hub that ignores SHARED_PROCESS_HEADER) is
          // answered as an empty server, message by message, and nothing is switched off for the other sessions.
          if (SHARED_PROCESS && channel) return failAll(body, SESSION_NOT_ENABLED);
          if (SHARED_PROCESS) {
            for (const m of Array.isArray(body) ? body : [body]) answerNotEnabled(m);
            return;
          }
          handle = answerNotEnabled;
          for (const m of Array.isArray(body) ? body : [body]) answerNotEnabled(m);
          return;
        }
        // Billing lapsed: refuse THESE CALLS with the hub's own sentence and KEEP THE SERVER UP. A 402
        // is not a reason for the proxy to die, and the user's other tools must keep working (#416 §8
        // item 6). Deliberately NOT handled like the not-enabled case above: that one silences the whole
        // client because OpenCadre genuinely has no business in that project, whereas a lapsed workspace
        // still has a hub whose reads work -- so the tool call is refused with the reason, and the
        // session carries on rather than going dark.
        if (isBillingReadOnly(res.status, parsed)) {
          return failAll(body, `OpenCadre: ${typeof parsed?.error === "string" ? parsed.error : "this workspace's plan has lapsed, so OpenCadre cannot accept writes right now"}`);
        }
        // The SDK answers JSON-RPC errors itself; pass those through as they are.
        if (parsed && typeof parsed === "object" && parsed.jsonrpc && parsed.error) {
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m.id === null && ids.length === 1 ? { ...m, id: ids[0] } : m);
          return;
        }
        hubSays = typeof parsed?.error === "string" ? parsed.error : typeof parsed?.error?.message === "string" ? parsed.error.message : "";
      } catch { /* not JSON */ }
      return failAll(body, redact(`OpenCadre hub: ${hubSays || `HTTP ${res.status}`}${hubSays ? ` (HTTP ${res.status})` : ""}`));
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) return await relaySse(res);
    const text = await res.text();
    if (!text.trim()) return; // 202: a notification or response, nothing to relay
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failAll(body, `OpenCadre hub: unreadable response (HTTP ${res.status})`);
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) emit(m);
  } catch (err) {
    if (controller.signal.aborted) return; // cancelled by the client or shutting down: no answer is expected
    failAll(body, redact(`OpenCadre hub unreachable (${err.cause?.code ?? err.message})`));
  } finally {
    for (const id of ids) if (inflight.get(JSON.stringify(id)) === controller) inflight.delete(JSON.stringify(id));
  }
}

function handleForward(message) {
  // A cancel ends our own HTTP request, which releases whatever the hub was holding for it.
  if (message?.method === "notifications/cancelled") {
    inflight.get(JSON.stringify(message.params?.requestId))?.abort();
    return;
  }
  unprefixCall(message);
  // A Codex chat names itself through its hook's stamp. Checked before anything is sent, so a stamp
  // that does not verify never reaches the hub under any identity.
  const stamped = stampedChannelFor(message);
  if (stamped?.refusal) return failAll(message, stamped.refusal);
  // A "call" client (OpenCode) names its chat on each request (`_meta`), not at spawn. That id now travels on the
  // SAME per-chat channel a Codex stamp uses: the chat's own headers AND its own hub session. It used to rewrite
  // this process's headers while keeping the session opened at `initialize` under the app-start seat, and the hub
  // refuses a session used by a different agent (HTTP 401, "This API key doesn't match the agent this MCP session
  // belongs to"). Measured 2026-09-23 on OpenCode v2.0.10: every tool call from a chat failed that way.
  const called = stamped ? null : callChannelFor(message);
  if (called?.refusal) return failAll(message, called.refusal);
  const channel = stamped?.channel ?? called?.channel ?? null;
  // FAIL CLOSED FOR A STAMP CLIENT. Its MCP child may be shared by every chat in the app (Cursor documents
  // no process model), so an unstamped call has no chat to act as: answering it on this process's seat
  // would put every chat's unstamped calls under one agent, the fail-shared collapse this proxy exists to
  // prevent. Codex is NOT refused here: one Codex process is one chat, so its process seat is that chat.
  if (channel?.notEnabled) {
    // A project enabled after this process started must reach this chat without a restart (Codex-OpenCadre-8160 on
    // 5251108c): one shared process (Devin) outlives many chats. So refresh the list -- header-free, at most once per
    // ALLOWLIST_REFRESH_MS for the whole process -- and look again before refusing.
    const task = (async () => {
      await refreshAllowlist();
      if (folderAccess({ cwd: channel.folder, hub: device.hub, credential: device.credential }) === "unlisted") return failAll(message, SESSION_NOT_ENABLED);
      channel.notEnabled = false;
      await channelSession(channel);
      return forward(message, channel);
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
    return;
  }
  if (STAMP_ONLY && !channel && hasToolCall(message)) return failAll(message, UNSTAMPED_REFUSAL);
  if (POOLED_HOST && !channel && hasToolCall(message)) return failAll(message, POOLED_REFUSAL);
  // A chat whose session cannot be opened still sends the call, as that chat and with no session, so the hub's own
  // refusal (a lapsed plan, the agent cap, a removed seat) reaches it in its own words. The call can only ever act as
  // the chat that stamped it.
  const task = channel ? channelSession(channel).then(() => forward(message, channel)) : forward(message);
  pending.add(task);
  task.finally(() => pending.delete(task));
}

// --- Main loop --------------------------------------------------------------------------------

// --- Local opt-in: this folder is named to the hub only if its project is enabled ------------
//
// scripts/opencadre-config.mjs folderAccess. Refreshed here, at every start, with the credential alone (no folder
// headers), so a project enabled in the console reaches a new chat without another connect. A failed refresh keeps the
// last list; with none at all the hub is asked as before. An unlisted folder gets the not-enabled server from the
// first message, and nothing that names it or its chat -- not even initialize -- goes to the hub (the refresh names none). stdin stays paused until its listener below
// is attached, so nothing a client sends while this waits is lost.
if (device && !named.key) await syncProjectAllowlist({ hub: device.hub, credential: device.credential });
/** How often a refused session may trigger another refresh of the list (see handleForward). */
const ALLOWLIST_REFRESH_MS = Math.max(0, Number(process.env.OPENCADRE_ALLOWLIST_REFRESH_MS ?? 30_000));
let allowlistRefreshedAt = Date.now();
let allowlistRefreshing = null;
/** One header-free refresh at a time, and none sooner than ALLOWLIST_REFRESH_MS after the last. */
function refreshAllowlist() {
  if (allowlistRefreshing) return allowlistRefreshing;
  if (Date.now() - allowlistRefreshedAt < ALLOWLIST_REFRESH_MS) return Promise.resolve();
  allowlistRefreshing = syncProjectAllowlist({ hub: device.hub, credential: device.credential }).finally(() => {
    allowlistRefreshedAt = Date.now();
    allowlistRefreshing = null;
  });
  return allowlistRefreshing;
}
const processFolderUnlisted = Boolean(device && !named.key) && folderAccess({ hub: device.hub, credential: device.credential }) === "unlisted";
// A process serving several folders names none of its sessions by its own launch folder, and the hub does not check
// its seatless traffic's project: when that folder is unlisted, its name is simply left off.
if (SHARED_PROCESS && processFolderUnlisted && headers) {
  delete headers[PROJECT_HEADER];
  delete headers[PROJECT_NAME_HEADER];
}

let handle;
if (named.key) {
  diag(`a named OpenCadre agent is configured for this folder (${named.source}); standing down`);
  handle = answerStandDown;
} else if (!device) {
  diag("no device credential for this client; run the connect command from the console");
  handle = answerError(NOT_CONNECTED);
} else if (processFolderUnlisted && !SHARED_PROCESS) {
  // Silent on purpose, as for the hub's own project_not_enabled: this folder has nothing to do with OpenCadre.
  handle = answerNotEnabled;
} else if (!headers) {
  // Refusing is deliberate, and WHICH refusal it is matters to the reader: an absent variable is
  // usually a configuration or harness problem the user did not cause, a malformed one is a value
  // they can see and fix. Reported separately rather than as one generic "no session" message.
  //
  // A `from: "call"` client (OpenCode) never reaches this branch: it resolves to a stable app-start
  // seat at startup so that `initialize` can create and serve a tool list. That is the point - a
  // refusal here would leave the chat with zero tools and no way to send the id-carrying call.
  const reason = sessionAtStart?.reason ?? "absent";
  diag(`no usable session id (${reason}); refusing to act without a session identity`);
  handle = answerError(SESSION_REFUSALS[reason] ?? SESSION_REFUSALS.absent);
} else {
  handle = handleForward;
}

function onLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send(rpcError(null, "Parse error", -32700));
  }
  if (Array.isArray(message)) {
    if (handle === handleForward) return handleForward(message);
    for (const m of message) handle(m);
    return;
  }
  handle(message);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    onLine(line);
  }
});
process.stdin.on("end", async () => {
  if (buffer.trim()) onLine(buffer);
  buffer = "";
  // The client is closing: let short requests finish, then cut off anything still held (e.g. wait_for_message).
  const grace = setTimeout(() => {
    for (const controller of inflight.values()) controller.abort();
  }, SHUTDOWN_GRACE_MS);
  await Promise.allSettled([...pending]);
  clearTimeout(grace);
  process.exitCode = 0;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
