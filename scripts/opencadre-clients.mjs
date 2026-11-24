/** The supported clients, in ONE place.
 *
 * There used to be three hand-maintained lists that had to be kept in step by hand:
 *   - READERS          (scripts/opencadre-config.mjs)  name -> config reader
 *   - COMPUTER_TOOLS   (scripts/opencadre-config.mjs)  tools a computer credential serves
 *   - DEVICE_CLIENTS   (cli/lib/device.mjs)            tools `opencadre connect` sets up
 * plus MEASURING_CLIENTS, the tools connect recognizes but does not set up yet.
 *
 * The lists were duplicated and the comments instructed the reader to "keep in step" with the
 * other file. They drifted: a tool added to one was silently missing from the others, so
 * `opencadre connect` could refuse a tool that the runtime was already willing to serve, and the
 * runtime could look for a credential the installer never wrote. One table, three derived views.
 *
 * Adding a client is now a single edit here.
 */

// The one import this file has, and it is here for the same reason the rest of it is: `codexHome`
// belongs with the client table rather than beside any single caller, so the path a Codex install
// lives at is declared once. Everything else below is a pure table.
import { join } from "node:path";

/** How a reader gets the endpoint + key out of one tool's config file. Kept as a function so the
 * readers stay in the module that owns the config-file formats.
 *
 * Order matters: the lists below are joined into the CLI's usage text and error messages, so this
 * table keeps the order the previous hand-maintained lists were declared in.
 *
 * `sessionIdSource` says where a client's chats get their per-session identity. It is a property
 * of the CLIENT, not of the environment, which is why it lives here: the question is whether this
 * client's process lifetime equals its session lifetime, and only the client knows that.
 *   { from: "env", name, keeper? }  read a named variable; `keeper` survives session resets
 *   { from: "process" }             synthesize one id per process - valid ONLY because this client
 *                                   runs one server process per chat, so process identity IS chat
 *                                   identity. For a client that reuses one long-lived process
 *                                   across chats this would collapse every chat into one agent.
 *   { from: "call" }                read the id off each MCP request's `params._meta` (OpenCode
 *                                   sends `ai.opencode/sessionID` on every `tools/call`, measured -
 *                                   docs/design/HARNESS-OPENCODE-IDENTITY.md). The PROXY adopts it
 *                                   for the connection once a call arrives, because there is no
 *                                   startup channel: OpenCode runs ONE MCP child for the whole app
 *                                   and reuses it for every chat, so neither the env nor the process
 *                                   can name a chat. Until the first tool call there is no chat id,
 *                                   so at `initialize` the proxy creates under a STABLE, client-
 *                                   qualified app-start seat (`opencode-appstart`): stable so one
 *                                   app leaves one row rather than one per launch, qualified so two
 *                                   clients on a machine cannot silently share a row, and labelled
 *                                   app-start because that is the honest granularity before a chat
 *                                   value exists. It must NOT refuse to create - the tool list comes
 *                                   from the resolved session, so refusing would serve zero tools and
 *                                   the id-carrying call could never come (MCP-PROXY-CREATION-GATE.md
 *                                   §6).
 *   { from: "stamp" }               the chat's id arrives on each OpenCadre call, SIGNED by a pre-tool hook
 *                                   (`_opencadre_stamp`, verified by the proxy), because the client gives
 *                                   its MCP server no chat id in any channel (Cursor). Until a stamped call
 *                                   arrives the proxy holds no seat at all, and an unstamped call is
 *                                   refused: its MCP child may serve every chat, so its process is nobody.
 *
 * TWO CLIENTS, TWO MECHANISMS, AND THE DIFFERENCE IS A MEASURED PARAMETER - not a preference.
 * `from: "process"` (Codex) synthesizes a fresh id PER LAUNCH, which is correct on the normal path:
 * Codex runs one proxy per chat (measured, two threads spawn two MCP children). But Codex also
 * spawns the proxy EAGERLY at app start with no chat open (measured: three launches, zero thread
 * ids), so each of those launches mints a row for a chat that does not exist.
 *
 * The fix for that is NOT to make the process id stable. A client whose chat id NEVER ARRIVES -
 * Codex gives an MCP server no per-chat value in any channel, measured negative (HARNESS-CODEX.md
 * §5.4.1) - would never replace a stable seat, so every chat on the device would collapse onto one
 * row: the identity collapse this table's own warning describes, reached through the fix for the
 * phantom problem. Codex therefore keeps a per-launch id and LABELS the row instead
 * (`agents.liveness`, migration 38) - 'process' at mint, promoted to 'chat' on the first tool call.
 *
 * A client whose chat id DOES arrive later is the opposite case and correctly uses a STABLE
 * app-start seat that the chat's own id replaces on the first call - OpenCode, above. Same defect,
 * same symptom, opposite remedy, because the chat id arrives for one and not the other. Stated so
 * neither client is read as doing it wrong.
 *
 * Clients being measured have no `sessionIdSource`: they are not served, so they have no identity
 * to derive. Deliberately no "none" value - MEASURING_CLIENTS already means "recognized, not yet
 * served", and a second word for one state is how two vocabularies start.
 *
 * The field is `sessionIdSource`, not `sessionId`: `sessionId` already means a runtime VALUE
 * throughout this codebase (resolveHub, sessionHeaders, sessionIdOrNull, wake-daemon), and a
 * declaration object sharing that name would make one word mean two things exactly where a name
 * confusion produces an identity bug. */
const clients = {
  "claude-code": {
    reader: "claudeCode",
    device: true,
    measuring: false,
    sessionIdSource: { from: "env", name: "CLAUDE_CODE_SESSION_ID", keeper: "CLAUDE_CODE_HOST_SESSION_ID" },
  },
  codex: {
    reader: "codex",
    device: true,
    measuring: false,
    // "process" is correct ONLY while this client runs one server process per chat, which makes
    // process identity equal chat identity. IF THAT EVER STOPS BEING TRUE, THIS DECLARATION SILENTLY
    // BECOMES IDENTITY CHURN: two chats would collapse into one agent, which is the fail-shared
    // failure this whole area exists to prevent.
    //
    // THAT PROPERTY CANNOT BE VALIDATED FROM THIS REPO. The client spawns the MCP process itself -
    // cli/lib/device.mjs only writes the entry into the client's own config - so process lifetime is
    // owned by a third-party binary we neither control nor can observe. A test here would assert a
    // proxy, pass today, and keep passing after a client update changed its spawn policy, which is
    // worse than no test: it would certify the property that just broke. So the declaration is a
    // documented assumption, not an asserted one, and this comment is the record of that.
    sessionIdSource: { from: "process", name: "codex" },
  },
  dsh: {
    reader: null,
    device: true,
    measuring: false,
    // NO sessionIdSource, DELIBERATELY. This is #197's Antigravity conclusion reached a second
    // time: when a harness delivers its id PER EVENT, the hook's caller-supplied id is the
    // mechanism and a declaration is redundant at best.
    //
    // A DECLARATION WOULD ALSO BE UNSATISFIABLE, verified three ways rather than reasoned:
    //   1. resolveSessionId({ source: { from: "env", name: "DSH_SESSION_ID" } }) against a
    //      DSH-spawned child's env returns { ok: false, reason: "absent" }.
    //   2. DSH never writes DSH_SESSION_ID into its own process.env - searched the installed
    //      packages; the only assignment is inside dsh-shell-env, which sets it per SHELL call
    //      from execution.agent.session.header.id. It is injected for shell children and
    //      discarded; the host never holds it.
    //   3. the DSH_ namespace is not inherited by other children either (the scrub).
    // So `from: "env"` here would name a channel the consumer can never read, and would certify
    // an identity path that provably never runs.
    //
    // WHAT ACTUALLY CARRIES THE IDENTITY: examples/hooks/opencadre-dsh-session.mjs reads
    // `session_id` from the HOOK PAYLOAD and passes it to resolveHub, and resolveSessionId
    // checks a caller-supplied id BEFORE any declaration - so the hook needs nothing here.
    // Measured: a hook receives the chat id in its payload (envDshSessionId: null), and hooks
    // fire once per turn at Stop / UserPromptSubmit.
    //
    // THE DURABILITY NOTE IS UNAFFECTED and is still true: the id is bound in the session record
    // at creation, and every store directory matches its own header id.
    //
    // OPEN AND NAMED, NOT CLOSED BY THIS ROW: DSH's HTTP MCP tool calls (send_message, reply,
    // set_status) do NOT go through resolveHub at all. DSH's HTTP client sends whatever headers
    // its config computed, and that config is evaluated in the HOST process, which has no
    // per-chat id. So HTTP MCP tools stay machine-attributed until a per-chat MCP channel exists.
    // That is a DSH-platform question, not a table question, and it should not ship as if done.
    //
    // DO NOT RESOLVE THE ID BY WALKING THE SESSION STORE. It contains two directory shapes -
    // `session-<uuid>` and bare `<uuid>` - both live and both with identical contents. Measured:
    // 8 of 18 directories carry the prefix, so a reader matching /^session-/ sees 44% of chats and
    // misses the newest ones.
  },
  // Cursor (editor agent + `agent` CLI; one config serves both). SERVED through the same signed-stamp
  // channel Codex uses, read from Cursor's own hook engine (cursor-agent 2026.09.23-86fc751, see
  // docs/design/HARNESS-CURSOR-LOCAL.md §11) rather than from its docs:
  //   - every hook payload carries `session_id`, which Cursor fills with the chat's `conversation_id`
  //     ("stable across turns") when it has no session of its own;
  //   - a `preToolUse` hook sees each MCP call as `tool_name: "MCP:<tool>"` and may return
  //     `updated_input`, whose keys Cursor MERGES into the call's arguments.
  // So the stamp hook adds a signed copy of the chat's id to every OpenCadre call, and the proxy answers
  // as that chat (scripts/opencadre-mcp.mjs, stampedChannelFor) - one agent per chat whatever Cursor's
  // process-sharing model is, which its docs never state.
  //
  // `from: "stamp"` is the declaration for that: the MCP child learns no chat id at spawn (none of
  // env, argv or `_meta` carries one), so until a stamped call arrives it sits on a stable,
  // client-qualified app-start seat (`cursor-appstart`) exactly as OpenCode's `from: "call"` does, and
  // opens that seat only if an UNSTAMPED call ever needs it (the proxy's deferred seat).
  //
  // `toolPrefix`: Cursor's preToolUse names an MCP call `MCP:<tool>` WITHOUT its server, so hub names such as
  // `send_message` or `create_task` would be indistinguishable from another server's tools of the same name, and
  // the stamp would be merged into THEIR calls (review of 7948fb9, S1). The proxy therefore lists the hub's tools to
  // Cursor as `opencadre_<tool>` and strips the prefix on the way back, and the stamp hook matches only the prefix.
  //
  // `reader: "cursor"`: an older `connect --code oc_` wrote a named agent (`mcpServers.opencadre`) into
  // ~/.cursor/mcp.json. It must be SEEN, so the proxy stands down for it as it does for Claude Code and Codex rather
  // than serving a second set of tools beside it (review of 7948fb9, S2).
  cursor: { reader: "cursor", device: true, measuring: false, sessionIdSource: { from: "stamp", name: "cursor" }, toolPrefix: "opencadre_" },
  // Gemini CLI (@google/gemini-cli). SERVED the way Cursor is, read from its own bundle (0.61.0,
  // docs/research/HARNESS-ADAPTERS.md §3, docs/design/HARNESS-GEMINI.md): BeforeTool hands a hook the chat's
  // `session_id` and names an MCP call's server in `mcp_context.server_name`, and `hookSpecificOutput.tool_input`
  // replaces the call's arguments. So the stamp targets OUR server exactly and needs no tool prefix. `from: "stamp"` for the
  // same reason as Cursor: the session id is the CLI's per-session value (it changes on /clear), which only the hook
  // sees at call time. `reader`: a named agent an older `connect --code oc_` wrote into ~/.gemini/settings.json.
  gemini: { reader: "gemini", device: true, measuring: false, sessionIdSource: { from: "stamp", name: "gemini" } },
  // Qwen Code (@qwen-code/qwen-code). Its hooks are Claude Code's contract under Claude Code's event names
  // (`hookSpecificOutput.permissionDecision`, Stop `decision: "block"`, `stop_hook_active`), read in its 0.24.4
  // bundle, so our hooks run as they are, in the Claude dialect. IDENTITY IS AN ENVIRONMENT VARIABLE: the stdio MCP
  // child inherits `QWEN_CODE_SESSION_ID` when it is spawned, and one Qwen process is one agent.
  //
  // `hostHandoff` (review of 14c8f9a, B1): Qwen CHANGES that variable in its own process on /clear, /reset, /new and
  // /resume (`Config.startNewSession`), and its hooks inherit the new value while the MCP child keeps the old one. So
  // the proxy records the seat it holds under Qwen's pid and the hooks read it from there (opencadre-config.mjs,
  // findHostHandoff); the process keeps one agent across /clear, and its hooks keep naming it.
  //
  // `hostHandoff.entryEnv` / `pattern`: how the proxy recognises Qwen among its ancestors (a Node shim may sit between
  // them). Qwen sets QWEN_CODE_CLI to its own entry script before it spawns anything.
  //
  // `pooledHost` (B2): in ACP mode (`--acp`, which `qwen serve` and channels also run as their workers) Qwen shares
  // ONE MCP child among every session of the process (McpTransportPool), so the child's variable names no session in
  // particular. There the proxy holds no seat, takes each call's session from `_meta["qwen-code/invocation"]
  // .sessionId`, which Qwen attaches only for `qwen serve` and channels (an editor's ACP client gets none in 0.24.4),
  // and refuses a call that names none, rather than pool every session into one agent.
  //
  // `reader: "qwen"`: a named agent an older `connect --code oc_` wrote into ~/.qwen/settings.json wins, as elsewhere.
  qwen: {
    reader: "qwen", device: true, measuring: false, sessionIdSource: { from: "env", name: "QWEN_CODE_SESSION_ID" },
    // The pattern names the entry scripts, with either slash (review of 4f2516d, B2): the package's cli.js or cli-entry.js
    // (npm, standalone, auto-updated installs all keep them under a qwen-code folder), or a `qwen` launcher.
    hostHandoff: { entryEnv: "QWEN_CODE_CLI", pattern: String.raw`[\\/]@?qwen-code[\\/](.*[\\/])?cli(-entry)?\.js\b|[\\/]qwen(\.cmd|\.exe)?("|\s|$)` },
    pooledHost: { flags: ["--acp", "--experimental-acp"], callMeta: ["qwen-code/invocation", "sessionId"] },
  },
  // Amp (ampcode.com). SERVED through the signed stamp, but the stamp comes from a PLUGIN, not a hook: Amp has no
  // command hooks, and instead loads long-lived plugins from ~/.config/amp/plugins/ that see every tool call with its
  // `thread.id` and may replace its input (`{ action: "modify", input }`). One plugin process and one MCP child serve
  // many threads, so a thread's identity can only ride on each call, exactly as for Cursor and Gemini CLI.
  // examples/hooks/opencadre-amp-plugin.mjs stamps OpenCadre's calls, gates shell commands, and brings mail to a
  // thread - to an IDLE one too, through `appendUserMessage`. Read from Amp's plugin API reference (2026-09-24), not
  // yet run signed in (docs/research/HARNESS-ADAPTERS.md §3).
  amp: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "amp" } },
  // Cline's CLI (npm `cline` 3.0.65 on @cline/core 0.0.86). MEASURED with a scripted model (docs/research/HARNESS-ADAPTERS.md
  // §3): its MCP child is spawned per session with no session id in its environment, and `tools/call` carries no `_meta`.
  // Its `tool_call` file hook sees `sessionContext.rootSessionId` and may REPLACE the call's input (`overrideInput`), so
  // the shared stamp hook signs the session into OpenCadre's calls, as for Codex. `from: "stamp"`: an unstamped call is
  // refused. The hooks are ~/.cline/hooks/PreToolUse.mjs and PostToolUse.mjs, loading examples/hooks/opencadre-cline-hook.mjs.
  cline: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "cline" } },
  // Kilo Code's CLI (`kilo`, @kilocode/cli; an OpenCode fork on OpenCode's older plugin API). SERVED through the signed
  // stamp, from a PLUGIN like Amp: Kilo spawns ONE MCP child per project directory, shared by every session there, and
  // gives it no session id anywhere (not in its environment, not in `_meta`; measured on 7.7.9). The plugin
  // (examples/hooks/opencadre-kilo-core.mjs) sees each tool call with its `sessionID` and may change the call's
  // arguments in place, so it stamps OpenCadre's calls, gates shell commands, and prompts an idle session when mail
  // arrives (`client.session.promptAsync`). MEASURED live against the 7.7.9 binary with a scripted model
  // (docs/qa/HARNESS-MEASUREMENT.md §9).
  kilo: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "kilo" } },
  // Windsurf / Devin Desktop (Cascade). CLEARANCE ONLY, by design: its hooks read no JSON (a pre-hook blocks by exiting
  // 2), so no hook can name a conversation to an MCP server, continue a turn or add context. `gateOnly`: connect installs
  // the approval gate on `pre_run_command` and no session server; the gate names a risky command's conversation by its
  // `trajectory_id` and opens that conversation's seat to ask as it. `reader`: a named agent `connect --code oc_` wrote
  // into ~/.codeium/windsurf/mcp_config.json, which is how Windsurf gets OpenCadre's tools (one agent for all its chats).
  windsurf: { reader: "windsurf", device: true, measuring: false, sessionIdSource: { from: "stamp", name: "windsurf" }, gateOnly: true },
  // GitHub Copilot CLI (`copilot`). MEASURED against the real 1.0.88 binary in BYOK mode with a scripted model
  // (docs/research/HARNESS-ADAPTERS.md §3): each session gets its own stdio MCP process with
  // COPILOT_AGENT_SESSION_ID (a new one on /new and /clear, and per ACP session), so the row is an env client.
  // `metaStamp`: a SUBAGENT (`task`) runs under a session id of its own, but its calls go through its parent session's
  // MCP process, whose variable names the parent (measured, review of 3f5e2a1). A `preMcpToolCall` hook therefore signs
  // the calling session's id into the call's `_meta` (its `metaToUse` becomes the request's `_meta`), and a call
  // carrying that stamp acts as its own session. Top-level sessions (-p, /new, /clear, ACP) each get their own process.
  // `reader`: a named agent `connect --code oc_` wrote into ~/.copilot/mcp-config.json.
  copilot: { reader: "copilot", device: true, measuring: false, sessionIdSource: { from: "env", name: "COPILOT_AGENT_SESSION_ID" }, metaStamp: "opencadre/stamp" },
  // Goose (goose-docs.ai, repo aaif-goose/goose, read at 80c1197: docs/research/HARNESS-ADAPTERS.md §3). IDENTITY IS AN
  // ENVIRONMENT VARIABLE: Goose spawns a stdio extension per session with `AGENT_SESSION_ID` set to that session
  // (extension_manager/mod.rs), and re-spawns it under the new id on /new and resume. `callMeta`: every MCP request
  // also carries `_meta["agent-session-id"]` (session_context.rs), and when it does the call acts as THAT session. It
  // is the stronger source: an extension the model adds mid-session is spawned with no id and inherits whatever
  // AGENT_SESSION_ID Goose's own environment holds, which is stale when Goose was started from another Goose shell.
  //
  // `seatScope`: Goose numbers its sessions `YYYYMMDD_N` per data root (session_manager.rs), so two roots
  // (GOOSE_PATH_ROOT profiles) hand out the same ids. Under a relocated root the id is qualified by that root, the same
  // way in the proxy and in the hooks, which both inherit Goose's environment (review of d6a7ef7, B2).
  goose: { reader: null, device: true, measuring: false, sessionIdSource: { from: "env", name: "AGENT_SESSION_ID" }, callMeta: ["agent-session-id"], seatScope: "GOOSE_PATH_ROOT", initInstructions: true },
  // Antigravity (the `agy` CLI and the IDE, one "jetski" harness). MEASURED live on agy 1.2.9 with no account
  // (docs/qa/HARNESS-MEASUREMENT.md §10): its MCP child is spawned once per agy process with no conversation id in its
  // environment, and every `tools/call` carries `_meta["antigravity.google/conversation_id"]`, equal to the hooks'
  // `conversationId`. So the row is Goose's `callMeta` on a stamp-only seat: nothing is opened for the process, a call
  // naming its conversation acts as that conversation, and a call naming none is refused. The hooks hold the same id,
  // so once the session server is installed they may open the conversation's seat themselves (stampActive).
  antigravity: { reader: "antigravity", device: true, measuring: false, sessionIdSource: { from: "stamp", name: "antigravity" }, callMeta: ["antigravity.google/conversation_id"] },
  // Devin CLI (`devin`, Cognition; npm @cognition-ai/cli-<platform>; also Devin Desktop's default "Devin Local" agent).
  // MEASURED on 3000.6.11 headless against a fake backend: MCP servers are spawned ONCE per process and shared by every
  // session, with no session id in their environment or `_meta`, so each OpenCadre call is stamped by a PreToolUse hook
  // (`hookSpecificOutput.updatedInput`, merged) with the session's `session_id`. An unstamped call is refused.
  // `stampFolder`: one `devin acp` process (and Devin Desktop) serves sessions in several folders with ONE proxy, started
  // wherever Devin was launched, so the stamp also signs the session's own folder, and the proxy takes the call's
  // project from it (review of 47dab9a, B2).
  devin: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "devin" }, stampFolder: true },
  // Factory Droid (`droid`, npm @factory/cli; MEASURED on 0.226.2 headless with a scripted model and no account). Its MCP
  // service starts once per process and is shared, and every `tools/call` carries `_meta.assemblySessionId`, the session
  // id its hooks are handed as `session_id`. So the row is a stamp-only seat read from each call (Antigravity's shape):
  // nothing is opened for the process, and a call naming no session is refused. No stamp hook: the model cannot write
  // `_meta`. The hooks may open the session's own seat once connect installed them (stampActive).
  // `callMetaReject`: the ids Droid falls back to when it has none ("unknown-session" in McpHub, "unknown" in a tool's
  // context), which would put every such call on one shared agent (review of e7ee431, S1). `stampless`: Droid never
  // stamps, so a stamp in a call's arguments is refused rather than trusted before `_meta` (N3).
  droid: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "droid" }, callMeta: ["assemblySessionId"], callMetaReject: ["unknown-session", "unknown"], stampless: true },
  // Mistral Vibe (`vibe`; MEASURED on 2.25.8 headless with a scripted model and no account). A shared MCP pool with no
  // session id in env or `_meta`, so each OpenCadre call is stamped by a pre_tool hook (`tool_input`, which REPLACES
  // the arguments) with the session's `session_id`. An unstamped call is refused.
  vibe: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "vibe" } },
  // Crush (charmbracelet/crush; MEASURED on 0.96.1 headless with a scripted model and no account). One MCP child per
  // app, shared by every session, with no session id in its environment and no `_meta` on a call, so each OpenCadre call
  // is stamped by a PreToolUse hook (`updated_input`, merged) with the session's `session_id`. An unstamped call is
  // refused.
  crush: { reader: null, device: true, measuring: false, sessionIdSource: { from: "stamp", name: "crush" } },
  // Grok Build (xAI's `grok`, 1.0.41). MEASURED headless with a scripted model and no account (a `[model.<name>]`
  // base_url in ~/.grok/config.toml): every stdio MCP child is spawned per session with GROK_SESSION_ID in its
  // environment (two sessions in one `grok agent stdio` process got two children, each its own id), so the row is an env
  // client. A subagent's MCP calls go through its parent's child, so they act as the parent. Hooks are Claude-shaped
  // (with camelCase copies of every key), in ~/.grok/hooks/*.json; Grok also runs ~/.claude/settings.json hooks, which
  // stand down on a Grok payload once Grok's own gate is installed (hookHost, hostGateInstalled).
  grok: { reader: null, device: true, measuring: false, sessionIdSource: { from: "env", name: "GROK_SESSION_ID" } },
  // Measuring clients: reasonix. The enumeration is load-bearing - it is what a reader checks this block against - so it
  // names every `measuring: true` row below and nothing else.
  // OpenCode (opencode.ai, repo anomalyco/opencode). MEASURED on v2.0.10
  // (docs/design/HARNESS-OPENCODE-IDENTITY.md): an OpenCode chat's id reaches a `type: "local"` MCP
  // server as `params._meta["ai.opencode/sessionID"]` on each `tools/call`. It is NOT in the
  // environment and NOT in argv, and it is NOT on initialize/tools/list - so a proxy cannot read it
  // once at startup the way Claude Code's env var is read; it must take it from the call it is
  // answering. That is `{ from: "call" }` above.
  //
  // `from: "process"` would be WRONG for OpenCode, and the measurement is the reason: the background
  // service spawns ONE MCP child and reuses it for every chat (`ppid` is the service, shared across
  // projects), so process lifetime is the app's, not a chat's. Synthesizing an id per process would
  // collapse every chat on the machine into one agent - the fail-shared failure this area exists to
  // prevent, which is also why this is a DEVICE client reached through the local proxy: the remote
  // URL route has no per-call hook to read the id from.
  opencode: { reader: null, device: true, measuring: false, sessionIdSource: { from: "call", name: "opencode" } },
  // Reasonix: TOML [[plugins]], and a project ./reasonix.toml wins over the machine-wide config - the
  // nearest-file-wins precedence that gives a folder its own agent. Its reader exists, so a named agent
  // in its config resolves today. What is missing is the SESSION half: Reasonix exports no session-id
  // variable (Claude Code's from: "env" has no equivalent here), and whether it spawns one MCP process
  // per chat - the property that makes codex's from: "process" sound - HAS NOT BEEN MEASURED. Until it
  // is observed there is no honest sessionIdSource to declare, and an unobserved declaration is worse
  // than a missing one (see the codex comment above). So: recognized, not served.
  reasonix: { reader: "reasonix", device: false, measuring: true },
};

/** The reader names a client config can be read with, in lookup order. */
export const CLIENT_NAMES = Object.keys(clients);

/** Names of clients that have a config reader today. */
export const READER_NAMES = CLIENT_NAMES.filter((name) => clients[name].reader);

/** Tools one computer credential serves: each chat in them is its own session. */
export const COMPUTER_TOOLS = CLIENT_NAMES.filter((name) => clients[name].device);

/** Tools `opencadre connect` recognizes but does not set up yet: how their chats get their own
 * identity is still being measured. A distinct state, not "unsupported". */
export const MEASURING_CLIENTS = CLIENT_NAMES.filter((name) => clients[name].measuring);

/** Every client `opencadre connect` knows by name, in any state. */
export const CONNECT_CLIENTS = CLIENT_NAMES;

/**
 * Where Codex keeps its state, honouring `CODEX_HOME`. THE ONE RESOLVER — every OpenCadre writer and
 * reader that touches Codex's files goes through this, so a relocated install cannot get a config
 * written where Codex never looks (HARNESS-CODEX.md §9 item 7).
 *
 * `CODEX_HOME` is the state ROOT ITSELF, not a parent of it — the vendor's own environment-variable
 * page, fetched 2026-09-20:
 *
 *   "CODEX_HOME | CLI, IDE extension, app-server, installers | Default `~/.codex` | Sets the root for
 *    Codex state, including config, auth, logs, sessions, skills, and standalone package metadata.
 *    If you set it, the directory must already exist."
 *
 * So the fallback is `join(home, ".codex")` and the override REPLACES it; callers join their own leaf
 * (`config.toml`, `hooks.json`, `skills/…`) onto the result. Getting this backwards — treating it as a
 * parent, `join(CODEX_HOME, ".codex", …)` — would point every writer at a directory Codex never reads,
 * which is the failure this exists to prevent, so it is worth stating rather than inferring.
 *
 * The vendor's own measurement on the fleet PC agrees: the desktop app sets
 * `CODEX_HOME = 'C:\Users\dev\.codex'` (HARNESS-CODEX.md §2.1) — the `.codex` directory itself.
 *
 * AN EMPTY OR BLANK VALUE IS NOT AN OVERRIDE. `CODEX_HOME=""` is set-but-useless, and treating it as a
 * path would resolve every Codex file relative to nothing. Absent and blank both fall back.
 *
 * `env` is a parameter rather than a direct `process.env` read so a test can exercise it without
 * mutating the process for every other test in the file.
 */
export function codexHome(home, env = process.env) {
  const override = env?.CODEX_HOME;
  return override && String(override).trim() !== "" ? override : join(home, ".codex");
}

/** Where Amp keeps its settings and user plugins: $XDG_CONFIG_HOME/amp, else ~/.config/amp (on Windows too,
 * %USERPROFILE%\.config\amp). Read from Amp's own CLI (review of 597af1c, S5). THE ONE RESOLVER for Amp's folder,
 * like codexHome for Codex: connect, doctor, detection and the runtime all go through it. */
export function ampHome(home, env = process.env) {
  const override = env?.XDG_CONFIG_HOME;
  return override && String(override).trim() !== "" ? join(override, "amp") : join(home, ".config", "amp");
}

/** JSON with comments and trailing commas (Devin's config.json, which its own docs show with comments), parsed, else
 * null. Comments are removed outside strings only. */
export function parseJsonc(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
    } else {
      out += c;
    }
  }
  // Trailing commas, outside strings too.
  let clean = "";
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(i, j + 1);
      i = j;
    } else if (c === "," && /^\s*[}\]]/.test(out.slice(i + 1))) {
      continue;
    } else {
      clean += c;
    }
  }
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}
/** Where Devin keeps its user config (config.json with `hooks`, mcp_config.json): $XDG_CONFIG_HOME/devin, else
 * ~/.config/devin; on Windows %APPDATA%\devin (docs.devin.ai/desktop/cascade/mcp). THE ONE RESOLVER for Devin's folder. */
export function devinHome(home, env = process.env, platform = process.platform) {
  const set = (v) => typeof v === "string" && v.trim() !== "";
  // Windows first: Devin's docs name only %APPDATA%\devin there (review of 47dab9a, N2).
  if (platform === "win32" && set(env?.APPDATA)) return join(env.APPDATA, "devin");
  if (set(env?.XDG_CONFIG_HOME)) return join(env.XDG_CONFIG_HOME, "devin");
  return join(home, ".config", "devin");
}

/** Where Factory Droid keeps its config (mcp.json, hooks.json, settings.json): <FACTORY_HOME_OVERRIDE or home>/.factory
 * (the binary's own home lookup). THE ONE RESOLVER for Droid's folder. */
export function droidHome(home, env = process.env) {
  const override = env?.FACTORY_HOME_OVERRIDE;
  return join(typeof override === "string" && override.trim() !== "" ? override : home, ".factory");
}

/** Where Mistral Vibe keeps config.toml and hooks.toml: VIBE_HOME, else ~/.vibe (vibe/utils/paths.get_vibe_home). THE ONE
 * RESOLVER for Vibe's folder. */
export function vibeHome(home, env = process.env) {
  const override = env?.VIBE_HOME;
  return typeof override === "string" && override.trim() !== "" ? override : join(home, ".vibe");
}

/** Where Crush keeps its global crush.json: CRUSH_GLOBAL_CONFIG, else $XDG_CONFIG_HOME/crush, else ~/.config/crush (its
 * config.GlobalConfig, on every OS). THE ONE RESOLVER for Crush's folder. */
export function crushHome(home, env = process.env) {
  const set = (v) => typeof v === "string" && v.trim() !== "";
  if (set(env?.CRUSH_GLOBAL_CONFIG)) return env.CRUSH_GLOBAL_CONFIG;
  return join(set(env?.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config"), "crush");
}

/** Where Grok keeps its user config and hooks: GROK_HOME, else ~/.grok. THE ONE RESOLVER for Grok's folder. */
export function grokHome(home, env = process.env) {
  const override = env?.GROK_HOME;
  return override && String(override).trim() !== "" ? override : join(home, ".grok");
}

/** Where Cline keeps its things (@cline/shared storage): CLINE_DIR, else <home>/.cline; its data in CLINE_DATA_DIR,
 * else <that>/data; its MCP servers in CLINE_MCP_SETTINGS_PATH, else <data>/settings/cline_mcp_settings.json. THE ONE
 * RESOLVER for Cline's folders. */
export function clineDirs(home, env = process.env) {
  const set = (v) => typeof v === "string" && v.trim() !== "";
  const root = set(env?.CLINE_DIR) ? env.CLINE_DIR : join(home, ".cline");
  const data = set(env?.CLINE_DATA_DIR) ? env.CLINE_DATA_DIR : join(root, "data");
  return { root, data, hooks: join(root, "hooks"), mcp: set(env?.CLINE_MCP_SETTINGS_PATH) ? env.CLINE_MCP_SETTINGS_PATH : join(data, "settings", "cline_mcp_settings.json") };
}

/** Where Kilo keeps its global config: $XDG_CONFIG_HOME/kilo, else ~/.config/kilo (Kilo's `Path.config`, read in the
 * 7.7.9 binary). THE ONE RESOLVER for Kilo's folder: connect, doctor, detection and the runtime all go through it. */
export function kiloHome(home, env = process.env) {
  const override = env?.XDG_CONFIG_HOME;
  return override && String(override).trim() !== "" ? join(override, "kilo") : join(home, ".config", "kilo");
}

/** Where Goose keeps its config.yaml and where it discovers user plugins (config/paths.rs at 80c1197): under
 * GOOSE_PATH_ROOT (absolute) when set; else config in $XDG_CONFIG_HOME/goose or ~/.config/goose (Windows:
 * %APPDATA%\Block\goose\config) and plugins in ~/.agents/plugins. THE ONE RESOLVER for Goose's folders. */
export function gooseDirs(home, env = process.env, platform = process.platform) {
  const root = env?.GOOSE_PATH_ROOT;
  if (root && /^([A-Za-z]:[\\/]|[\\/])/.test(root)) return { config: join(root, "config"), plugins: join(root, ".agents", "plugins") };
  // etcetera ignores a relative XDG_CONFIG_HOME, and so does this.
  const xdg = env?.XDG_CONFIG_HOME && /^([A-Za-z]:[\\/]|[\\/])/.test(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null;
  const config = platform === "win32"
    ? join(env?.APPDATA || join(home, "AppData", "Roaming"), "Block", "goose", "config")
    : join(xdg ?? join(home, ".config"), "goose");
  return { config, plugins: join(home, ".agents", "plugins") };
}

/** Where Copilot CLI keeps its config: COPILOT_HOME, else ~/.copilot (read in its bundle). */
export function copilotHome(home, env = process.env) {
  const override = env?.COPILOT_HOME;
  return override && String(override).trim() !== "" ? override : join(home, ".copilot");
}

/** True when connect gives this client the approval gate and nothing else (Windsurf). */
export const gateOnlyFor = (client) => Boolean(clients[client]?.gateOnly);

/** The `_meta` key a client's pre-call hook signs the session into (Copilot), or null. */
export const metaStampFor = (client) => clients[client]?.metaStamp ?? null;

/** True when this client's session learns the fleet protocol only from the MCP server's `instructions` (Goose puts them
 * in the system prompt and shows no hook output to the model at session start). */
export const initInstructionsFor = (client) => Boolean(clients[client]?.initInstructions);

/** The environment variable whose value scopes this client's session ids (Goose's data root), or null. */
export const seatScopeFor = (client) => clients[client]?.seatScope ?? null;

/** The per-call `_meta` path a client names its session under beside its declared source (Goose), or null. */
export const callMetaFor = (client) => clients[client]?.callMeta ?? null;

/** Placeholder ids a client sends on a call when it has no session: never an identity. */
export const callMetaRejectFor = (client) => clients[client]?.callMetaReject ?? [];

/** Whether a client never stamps (its calls name their session in `_meta`), so a stamp in the arguments is refused. */
export const isStampless = (client) => clients[client]?.stampless === true;

/** True when this client's chats can be named by the computer credential. */
export const isComputerTool = (client) => COMPUTER_TOOLS.includes(client);

/** The reader function name for a client, or undefined when it has none yet. */
export const readerFor = (client) => clients[client]?.reader;

/** Where a client's chats get their per-session identity, or undefined when the client is not
 * served. See the table comment for what the values mean. */
export const sessionIdSourceFor = (client) => clients[client]?.sessionIdSource;

/** Whether this client's stamp also signs the session's folder (see the devin row). */
export const stampsFolder = (client) => clients[client]?.stampFolder === true;

/** The prefix the proxy puts on every hub tool name for this client ("" for none). See the cursor row. */
export const toolPrefixFor = (client) => clients[client]?.toolPrefix ?? "";

/** How this client's proxy finds its host and records its seat for the host's hooks (see the qwen row), or null. */
export const hostHandoffFor = (client) => clients[client]?.hostHandoff ?? null;

/** How to tell this client's host is sharing one MCP child among sessions, and where each call names its session. */
export const pooledHostFor = (client) => clients[client]?.pooledHost ?? null;

/**
 * The six capabilities `opencadre doctor` reports, in the order it reports them.
 *
 * These are LAUNCH-CLIENT-GATE.md §1's rows, and the doc's own words for why they are the set:
 * "A tool passes the gate when all six hold **on a real install**, measured and written down in its
 * docs/design/HARNESS-<TOOL>.md". The gate is the fleet's launch condition, so this list is the
 * shape the whole launch is argued in — it lives here, with the client table, rather than inside
 * doctor, because adding a capability is then one edit in one file.
 *
 * `doctor` is deliberately NOT a seventh row. The gate says so itself: "doctor is not a seventh
 * capability. It is the instrument that reports capabilities 1-5 for one tool on one machine."
 */
export const CAPABILITIES = [
  ["connect", "Connect", "one command (opencadre connect) detects the tool and writes its config"],
  ["identity", "Identity", "every chat is its own agent on the roster; two chats are two agents"],
  ["mail", "Mail", "the agent learns about new mail without the human asking"],
  ["clearance", "Clearance", "a risky command waits for a human's approval before it runs"],
  ["lapsed", "Lapsed bill", "when the workspace stops paying, hooks and proxy go quiet, never block"],
  ["verified", "Verified", "a smoke run on a real install is recorded and doctor reproduces it"],
];

/**
 * What `doctor` can actually CHECK for one client, and what it can only report as unmeasured.
 *
 * WHY THIS IS A TABLE AND NOT LOGIC IN doctor. The registry above already carries the discipline
 * this file was written to enforce — one table, three derived views, because "the lists were
 * duplicated and the comments instructed the reader to keep in step with the other file. They
 * drifted." A per-client doctor capability list written inside doctor would be the fourth copy of
 * the same mistake, so it lives beside the table it describes.
 *
 * TWO KINDS OF UNMEASURED, and the distinction is the whole point of the third outcome. A client is
 * unmeasurable here either because
 *   - it is not SERVED yet (`measuring: true` above — the registry already says "recognized, not
 *     served"), or
 *   - it has no config writer, so there is no file to read and nothing to check (see
 *     `hasConfigWriter` in the CLI's clients.mjs, whose comment names Grok as the case that throws
 *     a raw TypeError where a refusal belongs).
 * Both must report as `not-measured` and must never render as a pass. `doctor` names WHICH one it
 * hit, so a reader can tell "this tool is not served yet" from "this machine has no copy" —
 * different problems with different owners.
 *
 * THE CHECKS ARE DECLARED AS NAMES, not as functions, so this file stays a pure table with no
 * imports and no side effects: the CLI resolves each name to an implementation. A capability
 * absent from a client's row is `not-measured` by construction, which is the honest default —
 * silence is never read as a pass.
 */
export const DOCTOR_CHECKS = {
  // Connected via a named agent (oc_) or a computer credential (ocd_). Both write a config the
  // reader can parse; the hub probe then proves the identity is live.
  "claude-code": { served: true, checks: ["config", "hub_identity", "heartbeat", "hooks"] },
  codex: { served: true, checks: ["config", "hub_identity", "heartbeat", "hooks", "inbox_skill"] },
  // dsh is served (device: true) but was never given an inbox-skill or hooks installer, and its
  // identity arrives per-event in the hook payload rather than from a declaration — see the long
  // comment on its registry row. So the checks that exist for it are the served-machine ones.
  dsh: { served: true, checks: ["config", "hub_identity"] },
  // Cursor is served (device: true above): its `opencadre-session` entry lives in ~/.cursor/mcp.json and
  // its session hooks in ~/.cursor/hooks.json, both written by connect, so both are checkable here. No
  // `inbox_skill` (a Codex-only installation) and no `heartbeat` (no statusLine-style usage channel).
  cursor: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Gemini CLI is served like Cursor: its session server and hooks both live in ~/.gemini/settings.json.
  gemini: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Qwen Code: the same, in ~/.qwen/settings.json.
  qwen: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Amp: its session server lives in ~/.config/amp/settings.json and its "hooks" are the OpenCadre plugin in
  // ~/.config/amp/plugins/, both written by connect.
  amp: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Cline: its session server in cline_mcp_settings.json, its hooks in ~/.cline/hooks, both written by connect.
  cline: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Kilo: its session server and its plugin entry both live in ~/.config/kilo/kilo.json, written by connect.
  kilo: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Windsurf: gate only, so its hooks are all there is to check.
  windsurf: { served: true, checks: ["hooks"] },
  // Copilot CLI: its server in ~/.copilot/mcp-config.json, its hooks in ~/.copilot/hooks/opencadre.json.
  copilot: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Goose: its extension lives in config.yaml and its hooks in OpenCadre's plugin under ~/.agents/plugins/opencadre.
  goose: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Antigravity: its session server in ~/.gemini/config/mcp_config.json, its hooks (inbox and gate) in
  // ~/.gemini/config/hooks.json, both written by connect.
  antigravity: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Measuring clients: recognized by connect, not set up yet, so there is nothing on a machine to check.
  // Devin: its session server in ~/.config/devin/mcp_config.json, its hooks under `hooks` in config.json.
  devin: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Droid: its session server in ~/.factory/mcp.json, its hooks in the flat ~/.factory/hooks.json.
  droid: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Vibe: its session server in config.toml, its hooks in hooks.toml.
  vibe: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Crush: its session server and its hooks, both in crush.json.
  crush: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // Grok: its session server in ~/.grok/config.toml, its hooks in ~/.grok/hooks/opencadre.json.
  grok: { served: true, checks: ["config", "hub_identity", "hooks"] },
  // opencode arrived in the client table above with #445 (connect) and WAS measuring there: connectable
  // with a named agent, not served, no observed session-id source. **#460 IS that observation** — it
  // measured `params._meta["ai.opencode/sessionID"]` on every `tools/call` against v2.0.10 and promoted
  // the row to `device: true`, so the reason this comment used to give is now FALSE and is replaced
  // rather than left: a comment stating the reason for a row must move with the row, or the next reader
  // finds a justification the code no longer matches.
  //
  // IT IS SERVED NOW, AND TWO CHECKS IS THE MEASURED SET, not a placeholder. It gets `config` because
  // it is a JSON client with a `JSON_CLIENTS` entry, so `hasConfigWriter` is true and
  // `readExistingServer` can read `~/.config/opencode/opencode.json`; and `hub_identity` because the
  // device credential makes `/v1/devices/me` probeable. It does NOT get `hooks`, `inbox_skill` or
  // `heartbeat`: `HOOK_CLIENTS` is `["codex", "claude-code"]` and no opencode inbox skill exists, so
  // declaring them would promise checks that cannot run — the same `webhookLimiter` shape this goal
  // keeps finding, where a thing that exists nearby is read as the thing itself.
  opencode: { served: true, checks: ["config", "hub_identity"] },
  reasonix: { served: false, checks: [] },
};

/**
 * THE RULE THAT KEEPS THESE TWO TABLES HONEST, stated once so it is not re-derived per row:
 *
 *   a client that is SERVED declares at least one check, and every check it declares must be one
 *   `doctor` can actually run for that client.
 *
 * WHY IT IS WRITTEN DOWN. `COMPUTER_TOOLS` is derived from `device: true`, and the coverage test
 * requires every member of it to declare a check — so promoting a client to `device: true` (exactly
 * what #460 does to opencode) makes these two tables disagree until the doctor row moves too. The two
 * ways to silence that disagreement are both wrong: `served: true` with invented checks makes `doctor`
 * promise work it cannot do, and `served: false` leaves `COMPUTER_TOOLS` naming a served client the
 * doctor table denies. **The rule is the third option — move the row to the truth.**
 *
 * It is a constraint on how the tables RELATE, deliberately not a re-modelling of them, because a
 * rebase PR carrying a design refactor stops being reviewable as a rebase.
 */

/** The checks declared for a client, or an empty list when it declares none. */
export const doctorChecksFor = (client) => DOCTOR_CHECKS[client]?.checks ?? [];

/** Whether a client's config can be read and checked at all today. False for a client being
 * measured, and false for one with no writer — the caller distinguishes the two by reading
 * `MEASURING_CLIENTS`, which is why this answers only the one question. */
export const doctorServes = (client) => Boolean(DOCTOR_CHECKS[client]?.served);
