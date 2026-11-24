/** How each harness speaks to a hook, in ONE place, so one hook script can serve every harness.
 *
 * WHY THIS EXISTS. OpenCadre's hooks (awareness, approval gate, identity stamp) were written against
 * Claude Code's contract, and Codex happens to speak the same one. The next harness does not: Cursor
 * names its events in camelCase, puts a shell command at the top of the payload rather than under
 * `tool_input`, runs user hooks with the working directory set to `~/.cursor`, and reads its answers
 * from flat snake_case fields. Copying each hook per harness is how three hand-maintained client lists
 * drifted apart in this repo before (see scripts/opencadre-clients.mjs). So the differences live here,
 * as data plus five small functions, and adding a harness is a new row, not a new script.
 *
 * WHAT A ROW SAYS, all of it read from the vendor's own code where we had it:
 *   events       the harness's event name -> the canonical (Claude Code) one our hooks switch on
 *   output       "claude"  -> { hookSpecificOutput: {...} } / { decision: "block", reason }
 *                "cursor"  -> { permission, user_message, agent_message, updated_input,
 *                               additional_context, followup_message }
 *   silence      what "no opinion" must print. Claude Code and Codex read an empty stdout as success;
 *                Cursor logs an empty stdout as a FAILED hook run, and a non-JSON answer on a
 *                permission step BLOCKS the action, so its "no opinion" is the empty object `{}`.
 *
 * CURSOR'S ROW, and where each fact comes from: cursor-agent 2026.09.23-86fc751, the `hooks` module of
 * its bundle (docs/design/HARNESS-CURSOR-LOCAL.md §11 cites each line). Claude Code hooks loaded by
 * Cursor ("third-party imports", on by default) receive Cursor's payload too, which is why a Claude
 * hook must be able to tell it is running inside Cursor: see `hookHost`.
 */

import { win32 } from "node:path";
import { callMetaRejectFor, hostHandoffFor, sessionIdSourceFor } from "./opencadre-clients.mjs";
import { antigravityWorkspace, findHostHandoff, heldSeats, scopedSessionId } from "./opencadre-config.mjs";

/** Parse JSON from a hook runner. Cursor's Windows PowerShell pipeline can prefix
 * native-process stdin with a UTF-8 BOM; JSON.parse rejects that marker. All three
 * Cursor hooks use this reader so identity, awareness, and clearance agree. */
export function parseHookInput(raw) {
  return JSON.parse((raw || "").replace(/^\uFEFF/, "") || "{}");
}

/** The canonical event names our hooks are written against. */
const CLAUDE_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);

const DIALECTS = {
  claude: {
    events: Object.fromEntries([...CLAUDE_EVENTS].map((e) => [e, e])),
    output: "claude",
    silence: "",
  },
  cursor: {
    // `beforeShellExecution` is Cursor's dedicated pre-shell step; the gate treats it as PreToolUse
    // on a shell command, which is what it is.
    events: {
      sessionStart: "SessionStart",
      beforeSubmitPrompt: "UserPromptSubmit",
      preToolUse: "PreToolUse",
      beforeShellExecution: "PreToolUse",
      postToolUse: "PostToolUse",
      stop: "Stop",
    },
    output: "cursor",
    silence: "{}",
    // `updated_input` is merged into the call, so the stamp is sent alone.
    stampAlone: true,
  },
  // Gemini CLI (@google/gemini-cli 0.61.0, read in its bundle: HookEventName, createBaseInput,
  // BeforeToolHookOutput, the AfterAgent continuation in GeminiClient; docs/research/HARNESS-ADAPTERS.md §3).
  // Claude-shaped payload (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`) under its own event
  // names, plus `mcp_context.server_name` on an MCP call. A block is TOP-LEVEL `decision: "deny"|"block"`, not
  // Claude's nested permissionDecision; `hookSpecificOutput.tool_input` REPLACES the call's arguments on the
  // scheduler's path (then is validated against the tool's schema); `hookSpecificOutput.additionalContext` is injected; AfterAgent's
  // `decision: "block"` sends `reason` back as the next prompt. An empty stdout is no opinion (plain text would
  // become a systemMessage).
  gemini: {
    events: {
      SessionStart: "SessionStart",
      BeforeAgent: "UserPromptSubmit",
      BeforeTool: "PreToolUse",
      AfterTool: "PostToolUse",
      AfterAgent: "Stop",
    },
    output: "gemini",
    silence: "",
  },
  // Antigravity (IDE + `agy` CLI; docs at antigravity.google/docs/hooks and the `agy` 1.2.9 binary's own
  // hooks.proto, docs/research/HARNESS-ADAPTERS.md §2). Its payload carries no event name: the event is the
  // hooks.json key the command was listed under. The session is `conversationId`; a shell command is
  // `toolCall.args.CommandLine` on `run_command`; the folder is the session's `workspacePaths[0]` (never the
  // model-written `toolCall.args.Cwd`, see hookCwd).
  // A PreToolUse answer is `{ decision, reason }`, where "allow" APPROVES the call and skips the user's own
  // permission rules, so every answer that is not a deny is an EMPTY stdout. MEASURED on `agy` 1.2.9 (run live against
  // a scripted Gemini endpoint): empty stdout passes to the normal permissions, but `{}` and `{"decision":""}` DENY
  // ("tool call denied by pre-tool hook"), as do a timeout, a non-zero exit and output that is not JSON.
  antigravity: {
    events: {},
    output: "antigravity",
    silence: "",
  },
  // Goose (aaif-goose/goose 80c1197, crates/goose/src/hooks/mod.rs; docs/research/HARNESS-ADAPTERS.md §3). Hooks come
  // from a plugin's hooks/hooks.json in Claude's grouped shape, but the payload names its event in `event` (not
  // `hook_event_name`) and its folder in `working_dir`, and carries `session_id`, `tool_name`, `tool_input`. Only
  // PreToolUse and Stop read an answer: `{"decision":"block","reason"}` blocks the call, or keeps a Stop going with the
  // reason as a user message; an empty stdout is no opinion. Nothing a hook prints reaches the model otherwise, so
  // context is said as nothing. There is no `stop_hook_active`: `stopGuard` has the awareness hook remember which
  // mail it already stopped a turn for.
  // GitHub Copilot CLI 1.0.88, MEASURED against the real binary (docs/research/HARNESS-ADAPTERS.md §3). A hook file
  // keyed by camelCase events gets camelCase payloads with NO event name in them ({ sessionId, timestamp, cwd,
  // toolName, toolArgs, … }), so the installer passes the event on the command line (`--event`). Answers are flat:
  // `permissionDecision` / `permissionDecisionReason` on preToolUse, `additionalContext` on sessionStart and
  // userPromptSubmitted, `{decision:"block", reason}` on agentStop (which carries `stop_hook_active`), `metaToUse` on
  // preMcpToolCall. An empty stdout is no opinion; a timeout or invalid JSON lets the tool run; exit 1 denies it.
  copilot: {
    eventFromArgv: true,
    sessionField: "sessionId",
    events: { sessionStart: "SessionStart", userPromptSubmitted: "UserPromptSubmit", preToolUse: "PreToolUse", postToolUse: "PostToolUse", agentStop: "Stop", preMcpToolCall: "PreMcpToolCall" },
    output: "copilot",
    silence: "",
    // A timeout lets the command run (timeoutSec 600 as installed), so the gate's wait stays well inside it.
    waitCap: 540,
  },
  // Windsurf / Devin Desktop Cascade (docs.devin.ai/desktop/cascade/hooks, read 2026-09-24; not run here, it is an IDE).
  // Payload: { agent_action_name, trajectory_id, execution_id, timestamp, model_name, tool_info: { command_line, cwd } }.
  // A hook's output is NOT read: a pre-hook blocks only by exiting 2, with stderr as the message, so a deny is said
  // that way (`output: "windsurf"`, handled by the gate) and everything else is silence. The conversation is
  // `trajectory_id`. Only clearance fits: no hook can inject context, continue a turn or rewrite a call.
  windsurf: {
    eventField: "agent_action_name",
    sessionField: "trajectory_id",
    events: { pre_run_command: "PreToolUse" },
    output: "windsurf",
    silence: "",
    // The command RUNS on any exit but 2 (a crash included), so the gate blocks by exiting 2.
    blockExit: 2,
  },
  goose: {
    eventField: "event",
    events: Object.fromEntries([...CLAUDE_EVENTS].map((e) => [e, e])),
    output: "goose",
    silence: "",
    stopGuard: true,
  },
  // Grok Build (grok 1.0.41, MEASURED with a scripted model): Claude's payload keys (it also sends camelCase copies)
  // and Claude's answers. SessionStart and UserPromptSubmit are passive (their output is not read), while PostToolUse's
  // `additionalContext` reaches the model, so a session is told its name at its first tool result.
  grok: {
    events: Object.fromEntries([...CLAUDE_EVENTS].map((e) => [e, e])),
    introOnTool: true,
    // Stop also fires as the session ends (`reason: "shutdown"`, `"channel_closed"`); only this reason ends a turn.
    stopTurnReason: "end_turn",
    output: "claude",
    silence: "",
    // A hook killed at its timeout (600 as installed) lets the call run (review of 7ffc12c, B2).
    waitCap: 540,
  },
  // Devin CLI (Devin Desktop's "Devin Local"; devin 3000.6.11, MEASURED headless against a fake backend). Claude's
  // payload without `cwd`/`transcript_path`, and Claude's answers, with ONE difference: `permissionDecision: "allow"`
  // (or `decision: "approve"`) skips Devin's own approval prompt, so this row never says allow; a deny is Claude's.
  // `hookSpecificOutput.updatedInput` is shallow-MERGED into the call with or without a decision, so the stamp is sent
  // alone. The hook runs in the session's folder (`process.cwd()`), which no model command changes.
  devin: {
    events: Object.fromEntries([...CLAUDE_EVENTS].map((e) => [e, e])),
    output: "deny-only",
    silence: "",
    stampAlone: true,
    // A hook killed at its timeout (600 as installed) lets the call run.
    waitCap: 540,
    // A crash (exit 1), any other exit, or unreadable output also lets the call run; exit 2 blocks it (measured on
    // 3000.6.11, review of 47dab9a, S1). So the gate turns its own crash into exit 2.
    blockExit: 2,
  },
  // Factory Droid (`droid` 0.226.2, MEASURED headless with a scripted model and no account): Claude's payload
  // (session_id, cwd, transcript_path, permission_mode) and Claude's answers, from a FLAT ~/.factory/hooks.json. Like
  // Devin, `permissionDecision: "allow"` skips Droid's own permission prompt, so nothing but a deny is said. A hook that
  // times out or crashes (exit 1) lets the call run; exit 2 blocks it (exit 3 aborts the whole turn).
  droid: {
    events: Object.fromEntries([...CLAUDE_EVENTS].map((e) => [e, e])),
    output: "deny-only",
    silence: "",
    blockExit: 2,
    // Droid runs every matching hook and the FIRST JSON decision in config order wins, so an earlier `allow` (the
    // user's own hook, or one a repository ships in .factory/, which comes first) overrode a JSON deny and the command
    // ran; exit 2 blocks whatever came before, with stderr shown to the model (review of e7ee431, B1).
    denyExit: 2,
  },
  // Crush (charmbracelet/crush 0.96.1, MEASURED headless with a scripted model and no account; source at 00b33e4):
  // PreToolUse is its ONLY hook event, with { event, session_id, cwd, tool_name, tool_input } (no hook_event_name).
  // Matching hooks run in parallel. An answer is { decision: "deny"|"allow", reason, context, updated_input }: a deny wins,
  // an `allow` pre-approves Crush's own prompt (never said), `updated_input` is merged (the stamp is sent alone), and
  // `context` is appended to the tool's RESULT, which is what a PostToolUse answer does elsewhere, so awareness reads
  // the event as PostToolUse and a session hears its name at its first tool. Exit 2 blocks; a crash, other exit, timeout
  // or unreadable output lets the call run. No Stop hook: mail reaches a session only while it uses tools.
  crush: {
    eventField: "event",
    events: { PreToolUse: "PostToolUse" },
    introOnTool: true,
    output: "crush",
    silence: "",
    stampAlone: true,
    blockExit: 2,
    // A denied call drops every hook's `context`, and our gate may deny `bash`, so awareness says nothing there: a
    // session's name and its mail notice would be used up unseen (review of e6c51ae, S2).
    awarenessSkipsTools: ["bash"],
  },
  // Mistral Vibe (`vibe` 2.25.8, MEASURED headless with a scripted model and no account; source in the wheel):
  // ~/.vibe/hooks.toml `[[hooks]]` of type pre_tool / post_tool / post_agent; payload { hook_event_name, session_id,
  // parent_session_id, transcript_path, cwd, tool_name, tool_call_id, tool_input }. An answer is { decision, reason,
  // hook_specific_output: { tool_input | additional_context } }: a pre_tool `tool_input` REPLACES the arguments (then is
  // re-validated against the tool's schema); a post_tool `additional_context` is appended to the tool's result; a
  // post_agent deny injects `reason` as the next user message (at most 3 per hook per turn), with no stop_hook_active,
  // so the awareness hook remembers what it continued for (`stopGuard`). A hook that fails is allowed unless it is
  // `strict`, which denies: the gate is installed strict.
  vibe: {
    events: { pre_tool: "PreToolUse", post_tool: "PostToolUse", post_agent: "Stop" },
    introOnTool: true,
    output: "vibe",
    silence: "",
    stopGuard: true,
  },
  // Cline's CLI (npm `cline` 3.0.65, @cline/core 0.0.86; MEASURED with a scripted model, docs/research/HARNESS-ADAPTERS.md
  // §3). File hooks ~/.cline/hooks/<Event>.{mjs,js,…} get { hookName, taskId, sessionContext: { rootSessionId },
  // workspaceRoots, tool_call: { id, name, input } | tool_result: { … }, … }, and are awaited for PreToolUse
  // (`tool_call`) and PostToolUse (`tool_result`) only, for 120 s, after which the hook is killed and the call RUNS.
  // An answer is { overrideInput } (replaces the tool's input), { context } (added to the conversation) or
  // { cancel, errorMessage } (ends the run; the model never sees why). An empty stdout is logged as invalid JSON, so
  // "no opinion" is `{}`. The session is `sessionContext.rootSessionId`.
  cline: {
    eventField: "hookName",
    events: { tool_call: "PreToolUse", tool_result: "PostToolUse" },
    sessionOf: (input) => input?.sessionContext?.rootSessionId,
    // TaskStart and UserPromptSubmit run detached (their answer is not read), so a session hears its name at its first
    // tool result.
    introOnTool: true,
    output: "cline",
    silence: "{}",
    // Killed at 120 s, after which the call runs.
    waitCap: 100,
  },
};

/** Which dialect a client's hooks speak. Every client not listed speaks Claude Code's. */
const CLIENT_DIALECT = { cursor: "cursor", antigravity: "antigravity", gemini: "gemini", goose: "goose", copilot: "copilot", windsurf: "windsurf", cline: "cline", grok: "grok", devin: "devin", droid: "droid", crush: "crush", vibe: "vibe" };

export const dialectFor = (client) => DIALECTS[CLIENT_DIALECT[Array.isArray(client) ? client[0] : client] ?? "claude"];

/** The harness a hook payload came from, when the payload says so, else null.
 *
 * Cursor stamps `cursor_version` on every payload it sends (its hook executor adds it beside
 * `hook_event_name`), including the ones it sends to CLAUDE CODE hooks it has imported. So this is the
 * one field that tells a Claude Code hook it is running inside Cursor. */
export function hookHost(input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.cursor_version === "string") return "cursor";
  // Copilot CLI runs a repository's Claude-format hooks (.claude/settings.json) in a trusted folder, with a Claude-shaped
  // payload that adds an ISO `timestamp` Claude Code never sends, and with COPILOT_CLI=1 in the hook's environment.
  // COPILOT_CLI=1 leaks into everything Copilot's shell starts (a `gemini` or `claude` run from it), but
  // COPILOT_PROJECT_DIR is set only in the environment Copilot gives its HOOKS (measured on 1.0.88, review of a7db951),
  // so it is what says Copilot is running this hook. foreignHost narrows it further to Claude Code hooks.
  if (process.env.COPILOT_CLI === "1" && process.env.COPILOT_PROJECT_DIR && typeof input.timestamp === "string" && typeof input.hook_event_name === "string") return "copilot";
  // Grok Build sends every event in BOTH key styles, and its camelCase ones (`hookEventName`, `sessionId`,
  // `workspaceRoot`) are keys Claude Code never sends (measured on grok 1.0.41). Grok loads ~/.claude/settings.json hooks
  // by default, with Claude's matchers aliased (`Bash` = `run_terminal_command`).
  if (typeof input.hookEventName === "string" && typeof input.sessionId === "string" && typeof input.workspaceRoot === "string") return "grok";
  // Devin CLI (Devin Desktop's "Devin Local"): Claude-shaped, but with neither `cwd` nor `transcript_path` (both always
  // in Claude Code's payload), and DEVIN_PROJECT_DIR set for its hooks only (measured on devin 3000.6.11; it loads
  // ~/.claude/settings.json hooks too, with no matcher aliasing).
  if (process.env.DEVIN_PROJECT_DIR && typeof input.hook_event_name === "string" && input.cwd === undefined && input.transcript_path === undefined) return "devin";
  // Factory Droid: Claude's payload exactly, and it sets CLAUDE_PROJECT_DIR for its hooks too, so it is told apart only
  // by DROID_PROJECT_DIR, which it sets for its hooks alone (measured on 0.226.2).
  // Its `permission_mode` values (`off`, `auto-…`) are not Claude Code's either; a `claude` started from a Droid hook
  // inherits DROID_PROJECT_DIR but sends Claude's own modes (review of e7ee431, N1).
  if (process.env.DROID_PROJECT_DIR && typeof input.hook_event_name === "string" && /^(off|spec|auto-)/.test(String(input.permission_mode ?? ""))) return "droid";
  // VS Code's agent (GitHub Copilot Chat) runs Claude-format hooks from .claude/settings*.json when `chat.useClaudeHooks`
  // is on. Its payload adds an ISO `timestamp` and carries no `permission_mode` (chatHookService.ts), and it runs hooks
  // with the extension host's environment, which has no CLAUDE_PROJECT_DIR. Claude Code sends `permission_mode`, sends
  // no `timestamp`, and always sets CLAUDE_PROJECT_DIR for its hooks. Read from microsoft/vscode at 51e35ae; not run in
  // VS Code. Checked after Copilot CLI, which also sends `timestamp`. Only a Claude Code hook takes it (foreignHost).
  if (typeof input.timestamp === "string" && typeof input.hook_event_name === "string" && input.permission_mode === undefined && !process.env.CLAUDE_PROJECT_DIR) return "vscode";
  // Antigravity's common fields are camelCase and it sends no hook_event_name at all.
  if (typeof input.conversationId === "string" && Array.isArray(input.workspacePaths) && input.hook_event_name === undefined) return "antigravity";
  return null;
}

/** The harness this payload came from when it is NOT the client the hook was installed for, else null.
 *
 * WHY A HOOK MUST STAND DOWN ON A FOREIGN PAYLOAD. Cursor runs Claude Code's hooks by default and, since
 * it began filling `session_id` with the chat's `conversation_id`, those payloads pass the old "no
 * session_id means not ours" guard. A Claude Code hook would then resolve a Cursor chat as a Claude Code
 * session: the gate would ask for approval as the wrong agent (twice, beside Cursor's own gate), and the
 * Claude Stop watcher - an `asyncRewake` hook Cursor does not know, so it runs it IN the foreground with
 * its seven-day timeout - would hold the chat's stop. The hooks installed FOR Cursor handle Cursor chats;
 * everything else stays out. */
export function foreignHost(client, input) {
  const host = hookHost(input);
  const clients = [client].flat().filter(Boolean);
  if (!host) return null;
  // Copilot runs only CLAUDE CODE-format hooks from a repository, so only a hook installed for Claude Code can be one
  // it is running. A Gemini or Qwen hook seeing COPILOT_CLI=1 was started from Copilot's shell, and is its own tool's.
  // VS Code's fingerprint also fits Gemini CLI's and Qwen Code's own payloads (a `timestamp`, no `permission_mode`), so it
  // too is only ever a foreign host for a Claude Code hook.
  if (["copilot", "vscode", "devin", "droid"].includes(host) && !clients.includes("claude-code")) return null;
  // Grok loads Cursor's ~/.cursor/hooks.json too (`[compat.cursor] hooks = true`, its default), so a hook installed for
  // Cursor is also one Grok may be running (review of 7ffc12c, N1).
  if (host === "grok" && !clients.includes("claude-code") && !clients.includes("cursor")) return null;
  return clients.includes(host) ? null : host;
}

/** The canonical event name for this payload, or null for an event our hooks do not handle. */
export function hookEvent(client, input) {
  const d = dialectFor(client);
  // A dialect that names its own event field reads ONLY that one: ~/.agents/plugins is a cross-vendor location, and
  // another harness's Claude-shaped payload must not be handled as Goose's.
  const argv = process.argv.indexOf("--event");
  const raw = d.eventFromArgv ? (argv > -1 ? process.argv[argv + 1] : undefined) : d.eventField ? input?.[d.eventField] : input?.hook_event_name;
  if (typeof raw !== "string") return null;
  return d.events[raw] ?? null;
}

/** The folder the chat works in. Claude Code and Codex send `cwd`; Cursor sends `workspace_roots` and
 * runs a user-level hook with its working directory set to `~/.cursor`, so `process.cwd()` there would
 * name the wrong project. */
export function hookCwd(input, fallback = process.cwd()) {
  // Cursor on Windows sends a URI-style root such as /C:/work. Node treats that as
  // \C:\work, so both the project policy and git remote lookup miss the repo.
  const hostPath = (value) => process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(value)
    ? win32.normalize(value.slice(1)) : value;
  if (typeof input?.cwd === "string" && input.cwd) return hostPath(input.cwd);
  // Grok Build names the session's folder `workspaceRoot`.
  if (typeof input?.workspaceRoot === "string" && input.workspaceRoot) return hostPath(input.workspaceRoot);
  // Windsurf's `tool_info.cwd` is NOT used: it is run_command's `Cwd` argument, which the model writes, and a model told
  // to run `rm -rf /work/A/src` with Cwd set to a folder of a laxer (or no) project would pick that project's policy
  // (review of 03d4382, B1). Windsurf runs its hooks in the workspace root (the root of the repo being worked on, in a
  // multi-repo workspace) unless a hook sets `working_directory`, which connect does not, so the fallback below,
  // process.cwd(), is the session's own folder.
  // Goose names the session's folder `working_dir`.
  if (typeof input?.working_dir === "string" && input.working_dir) return hostPath(input.working_dir);
  // The SESSION's folder, never a tool argument: Antigravity's `toolCall.args.Cwd` is written by the model, and this
  // folder decides which clearance policy applies (its project key and its .opencadre/approval-gate.json). A model
  // told to run `rm -rf /work/A/src` with Cwd /tmp would otherwise pick a laxer project (review of 8c294fd, finding 1).
  const roots = [input?.workspace_roots, input?.workspacePaths, input?.workspaceRoots].find(Array.isArray);
  const root = roots?.find((r) => typeof r === "string" && r);
  if (root) return hostPath(root);
  // Antigravity's CLI sends `workspacePaths: []` and runs hooks in ~/.gemini/config, so its conversation's workspace
  // is the agy process's own working directory (opencadre-config.mjs antigravityWorkspace; never a file the model can
  // rewrite where the process tree can be read).
  if (Array.isArray(input?.workspacePaths) && typeof input.conversationId === "string") {
    const found = antigravityWorkspace();
    if (found) return found;
  }
  return fallback;
}

/** The chat's own id on a hook payload: `session_id` (Claude Code, Codex, Cursor, Gemini CLI), else Antigravity's
 * `conversationId`. undefined when the payload names no chat.
 *
 * A client whose host changes its session under the hooks (`hostHandoff` in the client table: Qwen Code) is the
 * exception. Its MCP child keeps the id it was spawned with, while /clear, /reset, /new and /resume give the hooks a
 * new one (review of 14c8f9a, B1). So the hook asks the child which seat it holds, through their shared host process
 * (opencadre-config.mjs, findHostHandoff), and names that. A host that shares one child among sessions (Qwen's ACP
 * mode) records no seat: each session is named by its own id, which Qwen puts in QWEN_CODE_SESSION_ID for that
 * session's hooks. With no record (the child is not running), the variable, as before. */
export function hookSessionId(input, client) {
  const name = [client].flat()[0];
  if (hostHandoffFor(name)) {
    const variable = sessionIdSourceFor(name)?.from === "env" ? process.env[sessionIdSourceFor(name).name] : undefined;
    const held = findHostHandoff({ client: name, spec: hostHandoffFor(name) });
    if (held?.mode === "process" && held.seat) return held.seat;
    if (typeof variable === "string" && variable) {
      // No record for this host (its child has not started yet, say) and ANOTHER live host's child holds this very id
      // as its seat (`qwen --resume` of a running session): naming it would act as that other process. Say nothing
      // rather than borrow it (review of e5f165e, should-fix 1).
      if (!held && heldSeats({ client: name }).has(variable)) return undefined;
      return variable;
    }
  }
  // A placeholder the client sends when it has no session (Droid's "unknown") names no one (review of fa41b69, S-A).
  if (typeof input?.session_id === "string" && callMetaRejectFor(name).includes(input.session_id)) return undefined;
  // Scoped the way the proxy scopes it (Goose's data root; unchanged for every other client).
  if (typeof input?.session_id === "string") return scopedSessionId(name, input.session_id);
  // A dialect that names the session in its own field (Copilot's camelCase `sessionId`), or deeper (Cline's
  // `sessionContext.rootSessionId`).
  const nested = dialectFor(name).sessionOf?.(input);
  if (typeof nested === "string" && nested) return nested;
  const field = dialectFor(name).sessionField;
  if (field && typeof input?.[field] === "string") return input[field];
  if (typeof input?.conversationId === "string") return input.conversationId;
  return undefined;
}

/** Every command a Cline `run_commands` input will run, as one line, or undefined when a part cannot be read. Cline takes
 * a string, a list, `{ commands: string | list }`, `{ command, args? }` or `{ cmd }`, and a list item may itself be
 * `{ command, args }` (@cline/core 0.0.86: `aZ`, rendered by `Df`), so each shape is read the way Cline runs it (review
 * of 2ff9038, B1: the other shapes ran unheld). */
export function clineCommandLine(input) {
  const list = typeof input === "string" ? [input]
    : Array.isArray(input) ? input
    : input && typeof input === "object"
      ? ("commands" in input ? (Array.isArray(input.commands) ? input.commands : [input.commands])
        : "command" in input ? ("args" in input ? [input] : [input.command])
        : "cmd" in input ? [input.cmd] : [input])
      : [];
  const render = (c) => {
    if (typeof c === "string") return c;
    if (!c || typeof c !== "object" || typeof c.command !== "string") return undefined;
    const args = Array.isArray(c.args) ? c.args : c.args === undefined ? [] : undefined;
    if (!args || !args.every((a) => typeof a === "string")) return undefined;
    return [c.command, ...args.map((a) => (/[\s"]/u.test(a) ? JSON.stringify(a) : a))].join(" ");
  };
  const lines = list.map(render);
  return lines.length > 0 && lines.every((l) => typeof l === "string") ? lines.join(" && ") : undefined;
}

/** The shell command a pre-execution payload is about to run, or undefined.
 * Claude Code: `tool_input.command` (a string). Codex: the same, sometimes as an argv array.
 * Cursor's beforeShellExecution: `command` at the top level. */
export function hookCommand(input) {
  // Cline: `run_commands` runs a LIST of commands; all of them are judged as one line, so any risky one holds the call.
  if (input?.tool_call && typeof input.tool_call === "object") return input.tool_call.name === "run_commands" ? clineCommandLine(input.tool_call.input) : undefined;
  // Antigravity: only `run_command` runs a shell, and its command is `CommandLine`.
  if (input?.toolCall && typeof input.toolCall === "object") {
    const line = input.toolCall.name === "run_command" ? input.toolCall.args?.CommandLine : undefined;
    return typeof line === "string" ? line : undefined;
  }
  // Keystrokes typed into a running shell (Copilot's write_bash / write_powershell, Devin's write_to_process): the
  // typed text is the command. The gate joins it with what was typed since the last Enter (typedShellInput).
  const typedIn = typedShellInput(input);
  if (typedIn) return typedIn.text;
  const toolArgs = copilotToolArgs(input);
  // Windsurf's pre_run_command: `tool_info.command_line`.
  const windsurf = input?.tool_info?.command_line;
  const raw = input?.tool_input?.command ?? (input?.tool_name === "exec_command" ? input?.tool_input?.cmd : undefined)
    ?? (input?.tool_input === undefined ? input?.command ?? toolArgs?.command ?? windsurf : undefined);
  if (Array.isArray(raw) && raw.every((part) => typeof part === "string")) return raw.join(" ");
  return typeof raw === "string" ? raw : undefined;
}

// Copilot's docs show `toolArgs` as a JSON string (1.0.88 sends an object): both are read.
function copilotToolArgs(input) {
  let toolArgs = input?.toolArgs;
  if (typeof toolArgs === "string") {
    try {
      toolArgs = JSON.parse(toolArgs);
    } catch { /* unreadable: no command */ }
  }
  return toolArgs;
}

/** Devin's key names in `bytes_input`, as the bytes it sends (measured on 3000.6.11, review of 3a79037, S1):
 * `<CR>`/`<C-m>` are CR, `<LF>`/`<C-j>` LF, `<TAB>`/`<C-i>` TAB, any case. Enter, either way, ends a line here. */
const devinKeys = (text) => text.replace(/<(cr|c-m|lf|c-j)>/gi, "\n").replace(/<(tab|c-i)>/gi, "\t");

// Keys that EDIT the line rather than add to it (Devin's key names: `<BS>`, `<C-a>`, `<C-u>`, `<C-w>`, `<LEFT>`,
// `<HOME>`, `<ESC>`, … measured, review of 8fe0ca9, B2), and the raw control bytes they send. What the shell then runs
// is not the text the gate can read, so such a write is judged risky on its own (the gate's `typed-line-editing`
// rule). TAB, CR and LF are not in these: they are read as whitespace and Enter.
const EDIT_KEY_NAMES = /<(?:c-[^>]|m-[^>]|a-[^>]|s-[^>]+|bs|backspace|del|delete|esc|escape|up|down|left|right|home|end|pageup|pagedown|pgup|pgdn|insert|ins|f\d{1,2})>/i;
const EDIT_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// A write of nothing but Ctrl-C. Not Ctrl-D: readline deletes a character with it and keeps the line (review of
// c6edd89, B1), so it is a line-editing key like the others.
const INTERRUPT_ONLY = /^(?:<c-c>|\x03)+$/i;

/** Keystrokes a call types into a RUNNING shell, as { shell, text, edits, interrupt } (text undefined when
 * unreadable), else null: Copilot's write_bash / write_powershell (`input`) and Devin's write_to_process (exactly one of
 * `text_input`, literal, or `bytes_input`, with key names). CR is Enter too. `shell` names the shell, so the gate can
 * join this write to what was typed into the same shell since its last Enter: a command split across writes runs as
 * one (reviews of 3a79037 and 8fe0ca9). `edits` is true when a key or byte in it edits the line; `interrupt` when the
 * write is only Ctrl-C, which adds nothing to the line. */
export function typedShellInput(input) {
  let raw;
  let text;
  let shell;
  // Only Devin's bytes_input has key NAMES; its text_input and Copilot's input are literal (control bytes still count).
  let named = false;
  if (input?.tool_name === "write_to_process" && input.tool_input && typeof input.tool_input === "object") {
    const t = input.tool_input;
    // Devin refuses a write with both; one the gate cannot tell apart is unreadable, and denied (review of c6edd89, S2).
    const both = typeof t.bytes_input === "string" && typeof t.text_input === "string";
    raw = both ? undefined : typeof t.bytes_input === "string" ? t.bytes_input : typeof t.text_input === "string" ? t.text_input : undefined;
    named = typeof t.bytes_input === "string";
    text = named ? devinKeys(t.bytes_input) : raw;
    shell = String(t.shell_id ?? "");
  } else if (input?.tool_name === "write_stdin" && input.tool_input && typeof input.tool_input === "object") {
    const t = input.tool_input;
    raw = typeof t.chars === "string" ? t.chars : undefined;
    text = raw;
    shell = String(t.session_id ?? "");
  } else if (/^write_(bash|powershell)$/.test(String(input?.toolName ?? ""))) {
    const args = copilotToolArgs(input);
    raw = typeof args?.input === "string" ? args.input : undefined;
    text = raw;
    shell = String(args?.shellId ?? args?.shell_id ?? args?.sessionId ?? "");
  } else {
    return null;
  }
  if (typeof raw !== "string") return { shell, text: undefined, edits: false, interrupt: false };
  const interrupt = named ? INTERRUPT_ONLY.test(raw) : /^\x03+$/.test(raw);
  // Read after Enter and TAB's own names (<C-m>, <C-j>, <C-i>) are translated.
  const edits = !interrupt && ((named && EDIT_KEY_NAMES.test(text)) || EDIT_BYTES.test(raw));
  return { shell, text: text.replace(/\r\n?/g, "\n"), edits, interrupt };
}

/** What stays typed but unentered once `text` reaches a shell: everything after the last Enter that is not a line
 * continuation (a line ending in an odd number of backslashes goes on; review of 8fe0ca9, B3). */
export function unenteredTail(text) {
  const lines = String(text).split("\n");
  let start = lines.length - 1;
  while (start > 0 && /(^|[^\\])(\\\\)*\\$/.test(lines[start - 1])) start--;
  return lines.slice(start).join("\n");
}

/** What to print for "no opinion". */
export const silenceFor = (client) => dialectFor(client).silence;

/** Clients whose gate is awaited by an in-process plugin with NO timeout (Kilo, Amp): nothing kills it, so it keeps
 * the wait it is configured with. */
const UNBOUNDED_GATE_CLIENTS = new Set(["kilo", "amp"]);

/** The longest the approval gate may wait for a decision, in seconds. Every hook harness kills the gate at the timeout
 * connect gives it (600 s), and those measured then RUN the call: Copilot, Gemini CLI 0.61.0 and Qwen Code 0.24.4
 * (both measured by forcing a 4 s timeout: the `rm -rf` ran), Grok, Devin; Cline kills at 120 s. So the wait ends
 * inside that timeout, as the gate's own answer (a deny by default), never as "runs". Unmeasured harnesses get the
 * same cap: it only replaces a kill with the gate's answer. A repository's approval-gate.json or
 * OPENCADRE_APPROVAL_WAIT cannot raise it. */
export const waitCapFor = (client) => {
  const name = Array.isArray(client) ? client[0] : client;
  return dialectFor(client).waitCap ?? (UNBOUNDED_GATE_CLIENTS.has(name) ? Infinity : 540);
};

/** The exit code that blocks a call in a harness that RUNS the call when its pre-hook fails in any other way (crash,
 * other exit, unreadable output), else undefined. The gate exits with it when it crashes or cannot read its input. */
export const blockExitFor = (client) => dialectFor(client).blockExit;

/** Where a crash, a non-zero exit other than 2, or output that is not a decision LETS THE CALL RUN, but exit 2 blocks it
 * whatever was printed. Per client, not per dialect row: the claude row is also the default for clients whose exit-2
 * behaviour is not documented here (Qwen Code, Kilo, Amp, OpenCode), and those keep the gate's old crash behaviour.
 *   claude-code  "Exit 2's block is the one outcome JSON can't override"; any other exit with no valid decision JSON is a
 *                non-blocking error and the tool runs (code.claude.com/docs/en/hooks, read 2026-10-06)
 *   codex        a crash or error does not block; `permissionDecision: "deny"` or exit 2 does (developers.openai.com/
 *                codex/hooks, read for 9d1f's hook-latency design, 2026-10-05)
 *   cursor       0 = use the JSON, 2 = deny, anything else fails open unless the entry says `failClosed: true`
 *                (cursor.com/docs/hooks, read 2026-10-06; connect now writes failClosed on the gate)
 * The gate's crash handler answers with the dialect's deny AND this exit code, so the call is blocked even if the
 * printed answer is lost (opencadre-approval-gate.mjs). */
const CRASH_EXIT_BLOCKS = { "claude-code": 2, codex: 2, cursor: 2 };

/** The exit code that blocks a call when the gate itself fails on a command it holds as risky: the row's `blockExit`
 * where the harness blocks only that way, else exit 2 where it is documented to block (CRASH_EXIT_BLOCKS), else
 * undefined (the old crash behaviour stays). */
export const crashExitFor = (client) => {
  const name = Array.isArray(client) ? client[0] : client;
  return dialectFor(client).blockExit ?? CRASH_EXIT_BLOCKS[name];
};

/** The exit code a deny is said with (reason on stderr) where a JSON deny can be overridden by an earlier hook's
 * `allow` (Droid), else undefined. */
export const denyExitFor = (client) => dialectFor(client).denyExit;

/** Who stands behind an explicit allow: a PERSON's decision on this very command ("person"), or a standing grant a
 * person issued ("grant": person-issued, but not a fresh per-command decision). Nothing else may produce one. */
export const ALLOW_PROVENANCE = Object.freeze(["person", "grant"]);

/** The answer to a pre-execution permission step, as the string to print.
 *
 * `decision` is "allow" or "deny" (never "ask": Codex fails the hook run on it, and fails OPEN).
 * `provenance` says who stands behind an "allow": "person" (a person decided this command in OpenCadre) or "grant" (a
 * person's standing grant covered it). `byPerson: true` is the older spelling of provenance "person".
 *
 * F7 (board Q1f): ONLY a person's decision or a person-issued grant produces an explicit allow, in every dialect. Any
 * other "allow" (a policy fallback such as onTimeout / onHubUnreachable "allow", or a caller that forgot to say who
 * decided) is printed as the dialect's NO OPINION: the command goes back to the tool's own permission settings. That
 * is not a claim that a person will be prompted: with the tool's own auto-approval, bypass flag or allow rule, it may
 * run with no further human decision, which is why such configurations are unsupported for verified clearance. */
export function permissionOutput(client, decision, reason, { provenance = null, byPerson = false } = {}) {
  const d = dialectFor(client);
  const source = ALLOW_PROVENANCE.includes(provenance) ? provenance : byPerson === true ? "person" : null;
  if (decision !== "deny" && !(decision === "allow" && source)) {
    // Cursor logs an empty answer as a failed hook run; `agent_message` tells the model why, and decides nothing.
    if (d.output === "cursor") return JSON.stringify(reason ? { agent_message: reason } : {});
    return d.silence;
  }
  // Antigravity: only a deny is ever said. Its "allow" approves the call and skips the user's own permission rules,
  // and OpenCadre's approval is a decision about clearance, not a grant of Antigravity's permissions.
  // Anything else is an empty stdout: `agy` 1.2.9 reads `{}` as a deny.
  if (d.output === "antigravity") return decision === "deny" ? JSON.stringify({ decision: "deny", ...(reason ? { reason } : {}) }) : "";
  // Gemini CLI: a deny is a top-level decision. Anything else is said as nothing at all, so Gemini's own approval
  // mode still decides whether to confirm with the user.
  if (d.output === "gemini") return decision === "deny" ? JSON.stringify({ decision: "deny", ...(reason ? { reason } : {}) }) : "";
  // Copilot CLI: flat fields. A person's approval is said (it spares the user Copilot's own prompt for a command someone
  // already approved); a policy "allow" nobody decided is said as nothing, as for Cursor.
  // Windsurf reads no output; the gate turns a deny into exit 2 (see its `emit`).
  if (d.output === "windsurf") return "";
  // Devin: never an allow (it would skip Devin's own prompt); a deny in Claude's shape.
  // Vibe: a top-level deny; anything else is nothing.
  if (d.output === "vibe") return decision === "deny" ? JSON.stringify({ decision: "deny", reason }) : "";
  // Crush: its own envelope; an `allow` would pre-approve its prompt, so nothing but a deny is ever said.
  if (d.output === "crush") return decision === "deny" ? JSON.stringify({ decision: "deny", reason }) : "";
  // Devin and Droid: an `allow` would skip the harness's own prompt, so nothing but a deny is ever said.
  if (d.output === "deny-only") return decision === "deny" ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) : "";
  // Cline: a deny can only be said by REPLACING the command (a `cancel` ends the whole run without telling the model
  // why): it becomes an echo of the reason, and the reason is added to the conversation too. Anything else is `{}`.
  if (d.output === "cline") {
    if (decision !== "deny") return "{}";
    const said = String(reason || "Blocked by OpenCadre.").replace(/[^A-Za-z0-9 .,:;()/_@+=-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    return JSON.stringify({ overrideInput: { commands: [`echo "OpenCadre blocked this command, it was NOT run: ${said}"`] }, context: reason || "Blocked by OpenCadre." });
  }
  if (d.output === "copilot") {
    return JSON.stringify({ permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) });
  }
  // Goose: a deny is `decision: "block"`; its "allow" only lets the next hook run, so anything else is said as nothing.
  if (d.output === "goose") return decision === "deny" ? JSON.stringify({ decision: "block", reason: reason || "Blocked by OpenCadre." }) : "";
  if (d.output === "cursor") return JSON.stringify({ permission: decision, ...(reason ? { user_message: reason, agent_message: reason } : {}) });
  // OpenCode's clearance adapter reads this shape and turns an allow into `effect: "allow"` only when the gate says who
  // stands behind it, so a stale gate's policy allow cannot pre-approve OpenCode's own prompt either.
  const said = { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason };
  if (client === "opencode" && decision === "allow") said.opencadreProvenance = source;
  return JSON.stringify({ hookSpecificOutput: said });
}

/** Adds fields to a tool call's arguments. Codex REPLACES the arguments with `updatedInput` and applies
 * it only beside `permissionDecision: "allow"` (which does not pre-approve the call there); Cursor
 * MERGES `updated_input`'s keys into the call and needs no permission field, so none is sent: an
 * "allow" from a preToolUse hook is a decision this hook has no business making. */
export function updatedInputOutput(client, updatedInput) {
  const d = dialectFor(client);
  if (d.output === "cursor") return JSON.stringify({ updated_input: updatedInput });
  if (d.output === "cline") return JSON.stringify({ overrideInput: updatedInput });
  // Devin merges it, and needs no decision (one would approve the call past Devin's own prompt).
  if (d.output === "deny-only") return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } });
  // Vibe REPLACES the arguments with `tool_input`.
  if (d.output === "vibe") return JSON.stringify({ hook_specific_output: { tool_input: updatedInput } });
  // Crush merges `updated_input`, and needs no decision (one would pre-approve the call).
  if (d.output === "crush") return JSON.stringify({ updated_input: updatedInput });
  if (d.output === "gemini") return JSON.stringify({ hookSpecificOutput: { hookEventName: "BeforeTool", tool_input: updatedInput } });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } });
}

/** Context injected into the model at this event. */
export function contextOutput(client, event, text) {
  const d = dialectFor(client);
  if (d.output === "cursor") return JSON.stringify({ additional_context: text });
  if (d.output === "copilot") return JSON.stringify({ additionalContext: text });
  if (d.output === "cline" || d.output === "crush") return JSON.stringify({ context: text });
  if (d.output === "vibe") return JSON.stringify({ hook_specific_output: { additional_context: text } });
  // Goose shows no hook output to the model outside PreToolUse and Stop.
  if (d.output === "goose") return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** A Stop answer that keeps the agent going with `text` as its next instruction. Cursor submits
 * `followup_message` as the next user message; Claude Code and Codex read `decision: "block"`. */
export function followupOutput(client, text) {
  const d = dialectFor(client);
  if (d.output === "cursor") return JSON.stringify({ followup_message: text });
  // Vibe: a post_agent deny sends `reason` back as the next user message.
  if (d.output === "vibe") return JSON.stringify({ decision: "deny", reason: text });
  return JSON.stringify({ decision: "block", reason: text });
}
