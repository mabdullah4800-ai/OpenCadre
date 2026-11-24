import { join } from "node:path";
// The one CODEX_HOME resolver (§9 item 7), imported from clients.mjs rather than re-probed here: that
// file already carries the two-homes runtime import for the shared module, so a second probe in this
// one would be a second place the packed CLI can fail, for the same single value.
import { codexHome } from "./clients.mjs";
import { parseJsonConfig, readText } from "./files.mjs";

/** Session hook merge shared by scripts/install-session-hooks.mjs (repo checkout) and
 * `opencadre connect` (helpers in ~/.opencadre/bin). Existing OpenCadre entries are refreshed in
 * place, unrelated hooks and settings are never removed or reordered. Never touches keys: the hooks
 * find the key in the client's own MCP config at run time. */

export const HOOK_CLIENTS = ["codex", "claude-code", "cursor", "gemini", "qwen"];
const AWARENESS = "opencadre-awareness.mjs";
const WAKE = "opencadre-wake.mjs";
const USAGE = "opencadre-usage.mjs";
const GATE = "opencadre-approval-gate.mjs";
const STAMP = "opencadre-session-stamp.mjs";

/** The file names every OpenCadre hook command contains, exported so the READER (`doctor`) matches on
 * the same strings the WRITER builds its commands from.
 *
 * Without this, doctor would carry a second spelling of "opencadre-awareness.mjs", and the two would
 * drift exactly the way `LABELS` did between this CLI and doctor (see the note on that map in
 * doctor.mjs): a per-client fact duplicated in two files disagrees the moment one is edited. A reader
 * that matches nothing reports every install as broken, which is worse than not checking at all. */
export const HOOK_MARKERS = { awareness: AWARENESS, wake: WAKE, usage: USAGE, gate: GATE, stamp: STAMP };

/** Claude Code's tools that run a shell command, all of which the approval gate must see (F8).
 *
 * Claude Code on Windows has a PowerShell tool beside Bash. MEASURED on claude.exe 2.1.284: PreToolUse fires for it
 * with `tool_name: "PowerShell"` and `tool_input: { command, description }`, the same `command` Bash sends. A gate on
 * `Bash` alone let every PowerShell command through ungated. Exported so doctor checks an install against the same
 * list: a Bash-only install from before this fix must read as outdated, not as healthy. */
export const CLAUDE_GATE_TOOLS = ["Bash", "PowerShell"];

/** Whether a Claude Code hook `matcher` selects `tool`, for doctor. A matcher of only letters, digits, `_` and `|` is
 * read as an exact list of tool names (the form OpenCadre writes), anything else as a regular expression, and an
 * absent, empty or `*` matcher selects every tool. */
export function claudeMatcherCovers(matcher, tool) {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  const text = String(matcher);
  if (/^[A-Za-z0-9_|]+$/.test(text)) return text.split("|").includes(tool);
  try {
    return new RegExp(text).test(tool);
  } catch {
    return false;
  }
}
// The gate may hold the command while a person decides (ask mode waits up to 540 s by default).
const GATE_TIMEOUT = 600;
const TIMEOUT = 10;
// Claude Code enforces timeout even on asyncRewake hooks (600s by default), and the watcher must
// outlive a long idle stretch. Seven days stays far below Node's 24.8-day timer limit.
const WAKE_TIMEOUT = 7 * 24 * 60 * 60;

export const sessionHooksFile = (home, client, env = process.env) =>
  client === "codex" ? join(codexHome(home, env), "hooks.json")
    : client === "cursor" ? join(home, ".cursor", "hooks.json")
    : client === "gemini" ? join(home, ".gemini", "settings.json")
    : client === "qwen" ? join(home, ".qwen", "settings.json")
    : join(home, ".claude", "settings.json");

/** Gemini CLI's hooks, in its user settings file ~/.gemini/settings.json (the same file that holds its MCP servers).
 * Claude Code's grouped shape (`{ matcher, hooks: [{ type, command, timeout }] }`) under Gemini's own event names,
 * with timeouts in MILLISECONDS (DEFAULT_HOOK_TIMEOUT = 6e4 in its hook runner; read in 0.61.0):
 *   SessionStart  awareness: who this chat is, the protocol, the digest (`hookSpecificOutput.additionalContext`)
 *   BeforeAgent   awareness: the digest on each prompt
 *   AfterTool     awareness: the digest, throttled (shell and file tools only)
 *   AfterAgent    awareness: unread mail answers `decision: "block"`, which Gemini sends back as the next prompt
 *   BeforeTool    the approval gate on run_shell_command (600 s), and the identity stamp on OpenCadre's own MCP
 *                 server's tools (`mcp_opencadre-session_<tool>`: generateValidName joins server and tool with one
 *                 `_` and keeps the hyphen; the hook also checks `mcp_context`)
 * Refreshes our handlers in place and keeps every other group and handler as it was. */
function planGeminiHooks({ home, awarenessPath, gatePath, stampPath }) {
  const file = sessionHooksFile(home, "gemini");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const changed = [];
  const ms = (seconds) => seconds * 1000;
  const cmd = (path) => ({ type: "command", command: `node "${path}" --client gemini` });
  const awareness = { marker: AWARENESS, handler: { ...cmd(awarenessPath), timeout: ms(TIMEOUT) } };
  const wanted = [
    ["SessionStart", undefined, [awareness]],
    ["BeforeAgent", undefined, [awareness]],
    ["AfterTool", "run_shell_command|write_file|replace", [awareness]],
    ["AfterAgent", undefined, [awareness]],
    ...(gatePath ? [["BeforeTool", "run_shell_command", [{ marker: GATE, handler: { ...cmd(gatePath), timeout: ms(GATE_TIMEOUT) } }]]] : []),
    ...(stampPath ? [["BeforeTool", "mcp_opencadre-session_.*", [{ marker: STAMP, handler: { ...cmd(stampPath), timeout: ms(TIMEOUT) } }]]] : []),
  ];
  config.hooks ??= {};
  const ours = (h, marker) => String(h?.command ?? "").includes(marker);
  // A Claude Code idle watcher copied in by `gemini hooks migrate` would run in the foreground here (Gemini knows no
  // asyncRewake) with its seconds read as milliseconds; it is ours and wrong in this file, so it goes.
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) if (Array.isArray(g?.hooks)) g.hooks = g.hooks.filter((h) => !ours(h, WAKE));
  }
  for (const [event, matcher, handlers] of wanted) {
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : (config.hooks[event] = []);
    for (const { marker, handler } of handlers) {
      // A GROUP'S MATCHER IS NEVER REWRITTEN (review of 8c294fd, finding 2): a group holding both the gate and the
      // stamp, or one of ours inside a user's own group, would have its scope changed and the gate could stop
      // seeing shell commands. Our handler is taken OUT of any group with another matcher instead, and lives in a
      // group of its own with the matcher it needs.
      for (const g of groups) {
        if (!Array.isArray(g?.hooks) || (g.matcher ?? undefined) === matcher) continue;
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h) => !ours(h, marker));
        if (g.hooks.length !== before) changed.push({ marker, event: "matcher", from: g.matcher ?? "", to: matcher ?? "", timeout: undefined });
      }
      const existing = groups.filter((g) => (g.matcher ?? undefined) === matcher).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter((h) => ours(h, marker));
      for (const h of existing) {
        if (typeof h.command === "string" && h.command !== handler.command) changed.push({ marker, event, from: h.command, to: handler.command, timeout: h.timeout });
        Object.assign(h, handler);
      }
      if (existing.length === 0) groups.push({ ...(matcher && { matcher }), hooks: [{ ...handler }] });
    }
    // A group we emptied by moving our handler out is dropped rather than left as an empty shell.
    config.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  }
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, changed };
}


/** Cursor's user-level hooks file, ~/.cursor/hooks.json. Its shape is FLAT, unlike Claude Code's and Codex's
 * grouped one: `{ "version": 1, "hooks": { "<event>": [{ command, timeout, matcher, loop_limit }] } }`, read
 * from Cursor's own hook engine (cursor-agent 2026.09.23-86fc751; HARNESS-CURSOR-LOCAL.md §11). Cursor runs
 * user hooks through a shell with the working directory set to ~/.cursor, which is why every hook takes the
 * chat's folder from the payload's `workspace_roots` instead (opencadre-hook-dialect.mjs `hookCwd`).
 *
 * What each event carries:
 *   sessionStart          awareness: who this chat is, the fleet protocol, the digest (`additional_context`)
 *   beforeSubmitPrompt    awareness: the digest, and the identity if sessionStart ran before the chat existed
 *   postToolUse           awareness: the digest, throttled
 *   stop                  awareness: unread mail becomes a `followup_message`, so the agent answers it before
 *                         going idle, once per stop (`loop_limit: 1`), as Claude Code's Stop blocks once.
 *   preToolUse            the identity stamp, on OpenCadre's own MCP tools only (`opencadre_<tool>`, see below)
 *   beforeShellExecution  the approval gate: a risky command is held before it runs (`failClosed: true`: a gate that
 *                         fails blocks the command instead of letting it run)
 *
 * Refreshes our handlers in place and keeps every other handler, in order, exactly as it was. */
function planCursorHooks({ home, awarenessPath, gatePath, stampPath }) {
  const file = sessionHooksFile(home, "cursor");
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  const changed = [];
  const awareness = { marker: AWARENESS, handler: { command: `node "${awarenessPath}" --client cursor`, timeout: TIMEOUT } };
  const wanted = {
    sessionStart: [awareness],
    beforeSubmitPrompt: [awareness],
    postToolUse: [awareness],
    // One follow-up per stop, as Claude Code's and Codex's Stop blocks once (stop_hook_active): the hook is silent
    // on a stop that a follow-up already continued, and the limit says the same to Cursor.
    stop: [{ marker: AWARENESS, handler: { ...awareness.handler, loop_limit: 1 } }],
    // Cursor's preToolUse names an MCP call `MCP:<tool>`, WITHOUT its server. The proxy lists the hub's tools to
    // Cursor as `opencadre_<tool>`, so this matcher selects exactly OpenCadre's calls and no other server's.
    ...(stampPath && { preToolUse: [{ marker: STAMP, handler: { command: `node "${stampPath}" --client cursor`, timeout: TIMEOUT, matcher: "^MCP:opencadre_" } }] }),
    // THE GATE ALONE FAILS CLOSED (board 70f528b2). Cursor runs the command when a hook crashes, times out, cannot start,
    // or answers with a non-zero exit other than 2, unless the entry says `failClosed: true` (cursor.com/docs/hooks,
    // read 2026-10-06), so a broken gate would let a risky command run unpaused. The cost, accepted: a Cursor window
    // that cannot start `node` blocks every shell command until OpenCadre is repaired. The awareness, stamp and stop
    // entries stay fail-open: they only inform, and a failure there must not block the chat. Upgrades add the field
    // in place (Object.assign below), so an install from before gains it with no duplicate entry.
    ...(gatePath && { beforeShellExecution: [{ marker: GATE, handler: { command: `node "${gatePath}" --client cursor`, timeout: GATE_TIMEOUT, failClosed: true } }] }),
  };
  if (config.version === undefined) config.version = 1;
  config.hooks ??= {};
  for (const [event, handlers] of Object.entries(wanted)) {
    const list = Array.isArray(config.hooks[event]) ? config.hooks[event] : (config.hooks[event] = []);
    for (const { marker, handler } of handlers) {
      const existing = list.filter((h) => String(h?.command ?? "").includes(marker));
      for (const h of existing) {
        if (typeof h.command === "string" && h.command !== handler.command) changed.push({ marker, event, from: h.command, to: handler.command, timeout: h.timeout });
        Object.assign(h, handler);
      }
      if (existing.length === 0) list.push({ ...handler });
    }
  }
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, changed };
}

/** Returns { file, before, after } without writing; throws if the existing file isn't a JSON object.
 * For Claude Code the Stop entry also gets the wake script as an asyncRewake handler, which wakes an
 * idle session when mail arrives. Codex runs its watcher asynchronously and queues the thread. */
export function planSessionHooks({ home, client, awarenessPath, wakePath, usagePath, gatePath, stampPath }) {
  if (client === "cursor") return planCursorHooks({ home, awarenessPath, gatePath, stampPath });
  if (client === "gemini") return planGeminiHooks({ home, awarenessPath, gatePath, stampPath });
  const file = sessionHooksFile(home, client);
  const before = readText(file);
  const config = parseJsonConfig(file, before);
  // The OpenCadre handlers this run CHANGES, as { marker, from, to }: the command an existing entry
  // had, and the one it is being given.
  //
  // WHY THIS IS COLLECTED RATHER THAN DERIVED FROM `after` LATER. Codex records hook trust against the
  // hook's CURRENT HASH (DOCS, `developers.openai.com/codex/hooks`, fetched 2026-09-20), so a changed
  // command MAY be listed for review and skipped until a human trusts it (review status unverified: OpenCadre
  // does not compute Codex's hash; review of #692). Comparing `before` to `after`
  // would answer the wrong question: an EMPTY `before` differs from `after` too, and that is a first
  // install, which invalidates nothing. Only a handler that had one command and now has another
  // stales a stored hash, and only the writer knows which of the two it just did.
  const changed = [];

  // Qwen Code runs a hook under `bash -c` on POSIX, where `$PPID` is Qwen itself: the host whose MCP child recorded the
  // seat the hooks must name (opencadre-config.mjs, findHostHandoff). On Windows (cmd.exe or PowerShell) the hook
  // finds its host through its parent's parent instead.
  const hostPid = client === "qwen" && process.platform !== "win32" ? ' --host-pid "$PPID"' : "";
  // Quoted for Windows paths with spaces; --client tells each hook which MCP config holds this session's key.
  const awareness = { marker: AWARENESS, handler: { type: "command", command: `node "${awarenessPath}" --client ${client}${hostPid}`, timeout: TIMEOUT } };
  const wake = { marker: WAKE, handler: { type: "command", command: `node "${wakePath}" --rewake --client ${client}`, asyncRewake: true, timeout: WAKE_TIMEOUT } };
  // Codex Stop can run a long-lived async command. Its output is not the wake signal: the watcher
  // uses codex queue to deliver a new turn to this Stop payload's session_id.
  const codexWake = wakePath && client === "codex" && { marker: WAKE, handler: { type: "command", command: `node "${wakePath}" --codex-queue --client codex`, async: true, timeout: WAKE_TIMEOUT } };
  const usage = usagePath && { marker: USAGE, handler: { type: "command", command: `node "${usagePath}" --client ${client}`, timeout: TIMEOUT } };
  // THE GATE SITS IN THE EXECUTION PATH ON BOTH CLIENTS. Claude Code has always had it there (a
  // PreToolUse handler); Codex did not, and that absence was OURS rather than the vendor's -- measured
  // 2026-09-21 by a live Codex CLI session (6246) and confirmed in this file's own history: the gate
  // was only ever emitted for claude-code, and Codex got the post-execution recorder instead.
  //
  // Codex DOES support PreToolUse and it CAN deny (DOCS, developers.openai.com/codex/hooks, fetched
  // 2026-09-21): `hookSpecificOutput.permissionDecision = "deny"` refuses the call before it runs.
  //
  // ONE HAZARD LIVES HERE AND ONLY HERE, which is why it is a comment at the write site. Codex parses
  // `permissionDecision: "ask"` but DOES NOT SUPPORT IT -- "Codex marks the hook run as failed,
  // reports the error, and continues the tool call." That is FAIL-OPEN: a future edit that emits
  // "ask" on this path would silently PERMIT the command. The gate's own `ask` is an internal mode
  // that resolves to allow/deny before emitting, so it does not bite today. Keep it that way.
  const gate = gatePath && { marker: GATE, handler: { type: "command", command: `node "${gatePath}" --client ${client}${hostPid}`, timeout: GATE_TIMEOUT } };
  // The recorder is a DIFFERENT JOB from the gate and both are kept: a refusal says what did NOT
  // happen, a record says what DID, and an audit trail of executed commands is evidence a refusal can
  // never produce. Codex only -- Claude Code's PreToolUse gate already runs before the command.
  const report = gatePath && client === "codex" && { marker: `--report --client ${client}`, handler: { type: "command", command: `node "${gatePath}" --report --client ${client}`, timeout: TIMEOUT } };
  const typedCommit = gatePath && client === "codex" && { marker: `--typed-commit --client ${client}`, handler: { type: "command", command: `node "${gatePath}" --typed-commit --client ${client}`, timeout: TIMEOUT } };
  // THE IDENTITY STAMP, Codex only: Codex gives its MCP server no per-chat value, so this PreToolUse
  // handler adds a signed copy of the chat's session_id to every OpenCadre call and the proxy answers
  // as that chat (examples/hooks/opencadre-session-stamp.mjs). Claude Code needs none: its chats reach
  // the proxy with their own id in CLAUDE_CODE_SESSION_ID. It shares the gate's group, whose Codex
  // matcher already names both MCP prefixes; each handler ignores the calls that are not its own.
  const stamp = stampPath && client === "codex" && { marker: STAMP, handler: { type: "command", command: `node "${stampPath}"`, timeout: TIMEOUT } };

  // CODEX MATCHERS MUST NAME MCP TOOLS OR OUR OWN CALLS ARE INVISIBLE. Today's list is shell and file
  // tools only, so a handler installed with it CANNOT observe an OpenCadre MCP call -- which is why a
  // live session reported the payload question as "cannot tell" rather than a negative: the matcher
  // excluded the calls, so no payload could surface.
  //
  // THE PREFIX FORMS ARE `mcp__<server>__<tool>`, AND THE SERVER NAME HAS BEEN TWO THINGS. Corrected
  // 2026-09-21 after a first draft of this comment named only one -- and got it backwards.
  //
  // OUR WRITER names the table `opencadre-session` (SESSION_SERVER, cli/lib/clients.mjs:116), and a
  // hyphen does NOT survive into the canonical tool name: the docs' naming is `mcp__<server>__<tool>`
  // with the server normalised, so the live form is `mcp__opencadre_session__<tool>`. That is the one
  // a matcher must cover, and it is what a live Codex session reports (6246, 2026-09-21).
  //
  // A SECOND FORM ALSO EXISTS IN REAL HISTORY: `mcp__opencadre__<tool>`, from a session whose
  // namespace was literally `opencadre` (the hub's own serverInfo name, src/mcp.ts) -- visible in
  // Codex's logs both as `tools.mcp__opencadre__set_status(...)` and as the split fields
  // tool_namespace="mcp__opencadre" + tool_name="set_status". `mcp__opencadre_session__*` and
  // `mcp__opencadre__*` are DIFFERENT POPULATIONS in ~/.codex/logs_2.sqlite (53 vs 94 rows), so
  // neither can be dismissed as an artifact of the other.
  //
  // SO BOTH ARE MATCHED. Covering one and not the other is a filter that installs cleanly and never
  // fires for the machines using the other spelling -- the failure this whole change is about. The
  // cost of matching both is nil: a hook that fires on a name no call uses is inert, not wrong.
  //
  // (`mcp__opencadreget_messages`-style strings also appear in those logs; THOSE are field-
  // concatenation artifacts, with no separator at all, and are not a third form.)
  //
  // `matcher` is a regex string (DOCS), and the vendor's own examples include `mcp__filesystem__.*`.
  const MCP_PREFIXES = "mcp__opencadre_session__.*|mcp__opencadre__.*";
  const codexMatcher = (base) => `${base}|${MCP_PREFIXES}`;
  const toolMatcher = (base) => (client === "codex" ? codexMatcher(base) : base);

  // Codex matches tool names, so apply_patch (its file edit tool) needs listing too. It is a CODEX-only
  // name -- Claude Code has no such tool -- which is why the base differs per client and must not be
  // unified: a matcher filters names that exist in one client's vocabulary, so copying one client's
  // list to the other installs a filter that can never match there.
  //
  // Qwen Code is the same shape under its own tool names (its bundle's TOOL_NAME_ALIASES: run_shell_command, edit,
  // write_file); the Claude spellings are aliases there, and the canonical names are the ones written.
  const postToolBase = client === "codex" ? "Edit|Write|Bash|exec_command|write_stdin|apply_patch" : client === "qwen" ? "run_shell_command|edit|write_file" : "Edit|Write|Bash";
  // Qwen's `monitor` tool also runs a shell `command` of the model's choosing, so the gate sees it too.
  // Claude Code's shell tools are CLAUDE_GATE_TOOLS: Bash, and on Windows its PowerShell tool (F8).
  const shellTool = client === "qwen" ? "run_shell_command|monitor" : client === "codex" ? "Bash|exec_command|write_stdin" : CLAUDE_GATE_TOOLS.join("|");

  const wanted = {
    SessionStart: { matcher: client === "codex" ? "startup|resume|clear|compact" : undefined, handlers: [awareness] },
    UserPromptSubmit: { handlers: [awareness] },
    PostToolUse: { matcher: toolMatcher(postToolBase), handlers: [awareness, ...(report ? [report] : []), ...(typedCommit ? [typedCommit] : [])] },
    // Qwen Code: mail at the end of a turn only. Its async hooks feed context, they cannot start a turn, so an idle
    // Qwen session cannot be woken and no watcher is installed for it.
    Stop: { handlers: client === "claude-code" ? [awareness, wake] : client === "qwen" ? [awareness] : [awareness, ...(usage ? [usage] : []), ...(codexWake ? [codexWake] : [])] },
    ...((gate || stamp) && { PreToolUse: { matcher: toolMatcher(shellTool), handlers: [...(gate ? [gate] : []), ...(stamp ? [stamp] : [])] } }),
  };

  config.hooks ??= {};
  const isOurs = (h, marker) => String(h.command ?? "").includes(marker);

  /** Brings the group that holds OUR handlers onto the current matcher.
   *
   * Only a group that already holds one of this call's handlers is touched, so a user's own hook
   * group -- or another product's -- is never rewritten. A matcher MOVE is a change the trust hash
   * covers, so it is recorded in `changed` the same way a command move is, which is what makes the
   * caller's re-trust warning true for this edit as well.
   *
   * `matcher: undefined` means the event ignores matchers (Codex ignores it on Stop and
   * UserPromptSubmit), so there is nothing to refresh and a group that never had one is left alone.
   *
   * A MIXED group (ours beside a user's or another product's handlers) is never rewritten: widening
   * its matcher would start running those handlers on tools they never asked for (F8 review: a
   * foreign Bash-only hook would begin firing on PowerShell calls). The group is split instead into
   * its CONTIGUOUS RUNS, in place: each foreign run keeps the group's own matcher and fields, each run
   * of ours gets the new matcher. [f1, gate, f2] becomes [f1] [gate] [f2], so the flattened sequence
   * of handlers is exactly the original one (F8 re-review: moving ours to one end reordered them), and
   * every handler object is kept as it was.
   */
  function refreshMatcher(groups, matcher, handlers, isOursFn) {
    if (!matcher) return;
    const mine = (h) => handlers.some(({ marker }) => isOursFn(h, marker));
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      if (!hooks.some(mine)) continue;
      if (group.matcher === matcher) continue;
      changed.push({ marker: handlers[0].marker, event: "matcher", from: group.matcher ?? "", to: matcher, timeout: undefined });
      if (hooks.every(mine)) {
        group.matcher = matcher;
        continue;
      }
      const runs = [];
      for (const h of hooks) {
        const owned = mine(h);
        if (runs.length && runs[runs.length - 1].owned === owned) runs[runs.length - 1].hooks.push(h);
        else runs.push({ owned, hooks: [h] });
      }
      // The first foreign run stays in the original group object, so any field it carries survives by
      // reference; later foreign runs copy those fields. Runs of ours carry only the new matcher.
      let kept = false;
      const split = runs.map(({ owned, hooks: run }) => {
        if (owned) return { matcher, hooks: run };
        if (!kept) {
          kept = true;
          group.hooks = run;
          return group;
        }
        return { ...group, hooks: run };
      });
      groups.splice(i, 1, ...split);
      i += split.length - 1; // past every group just written
    }
  }
  for (const [event, { matcher, handlers }] of Object.entries(wanted)) {
    const groups = (config.hooks[event] ??= []);
    const missing = [];
    for (const { marker, handler } of handlers) {
      const existing = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h, marker));
      // Refresh in place so re-running after moving the hooks fixes the path without reordering anything.
      for (const h of existing) {
        // Record the change BEFORE overwriting it: `h.command` is the only copy of what the entry
        // used to say, and Object.assign destroys it. Only a real command change counts -- a re-run
        // whose paths are unchanged writes the same string back, and that invalidates nothing, which
        // is the measured reason this fix is warn-only rather than a rewrite.
        if (typeof h.command === "string" && h.command !== handler.command) {
          changed.push({ marker, event, from: h.command, to: handler.command, timeout: h.timeout });
        }
        Object.assign(h, handler);
      }
      if (existing.length === 0) missing.push(handler);
    }
    if (missing.length === 0) {
      // NO HANDLER IS MISSING, BUT THE MATCHER MAY STILL BE STALE -- and skipping here would ship a
      // fix that never reaches an existing install. Measured 2026-09-21: widening a matcher and
      // re-running left the installed `PostToolUse` group on the OLD value, because both of its
      // handlers already existed and this branch returned early. The change would have applied only
      // to fresh installs -- silent, green, and useless on exactly the machines that needed it.
      refreshMatcher(groups, matcher, handlers, isOurs);
      continue;
    }
    // Join the group already holding an OpenCadre handler, so upgrading an install keeps the Stop pair together.
    const ownGroup = groups.find((g) => (g.hooks ?? []).some((h) => handlers.some(({ marker }) => isOurs(h, marker))));
    if (ownGroup) ownGroup.hooks.push(...missing);
    else groups.push({ ...(matcher && { matcher }), hooks: missing });
    refreshMatcher(groups, matcher, handlers, isOurs);
  }
  // Claude Code exposes rate limits only to the statusLine command, which must also print the line.
  // A statusLine is personal, so only an absent one (or our own, to refresh its path) is written.
  if (usagePath && client === "claude-code" && (!config.statusLine || String(config.statusLine.command ?? "").includes(USAGE))) {
    // The statusLine is included in `changed` for the same reason as the hooks: it is a command this
    // file rewrites, and if its path moves, whoever reads the warning should be told the whole set
    // that moved rather than a subset. It is NOT hash-gated by Claude Code the way hooks are by Codex,
    // so the caller's message must not claim it is -- see the note on `changed` in cli/bin/opencadre.mjs.
    if (config.statusLine && typeof config.statusLine.command === "string" && config.statusLine.command !== `node "${usagePath}" --client claude-code --from-stdin`) {
      changed.push({ marker: "statusLine", event: "statusLine", from: config.statusLine.command, to: `node "${usagePath}" --client claude-code --from-stdin`, timeout: undefined });
    }
    config.statusLine = { type: "command", command: `node "${usagePath}" --client claude-code --from-stdin` };
  }
  return { file, before, after: `${JSON.stringify(config, null, 2)}\n`, changed };
}

// This project rule guides Cursor's model to the MCP tools it already leases.
// A separate owned file avoids touching any of the customer's other rules.
export function planCursorProjectRule({ projectRoot }) {
  const file = join(projectRoot, ".cursor", "rules", "opencadre.mdc");
  const before = readText(file);
  const marker = "<!-- OpenCadre native MCP rule -->";
  if (before.trim() && !before.includes(marker)) throw new Error("Cursor already has an unowned .cursor/rules/opencadre.mdc; leave it untouched and move it aside before connecting.");
  const after = [
    "---",
    "description: Use OpenCadre through Cursor native MCP tools",
    "alwaysApply: true",
    "---",
    marker,
    "When asked to use OpenCadre, call Cursor native MCP tools. OpenCadre tool names begin with opencadre_.",
    "Discover the enabled project server with GetDynamicTools if needed. Call opencadre_get_active_agents or another requested tool through CallMcpTool with server and toolName, or CallDynamicTool with namespace and toolName. Use the project server ID Cursor exposes; its folder component varies.",
    "Never start opencadre-mcp.mjs from Shell, build an identity stamp, or use direct HTTP as a substitute for a native MCP call.",
    "If the project MCP tool is absent, check that this chat belongs to the enabled project folder window. An empty Agents window has no project tools. Check Add agents, context, tools > MCP > Opencadre Project in this chat, then report the missing tool rather than bypassing it.",
    ""
  ].join("\n");
  return { file, before, after };
}
