#!/usr/bin/env node
// OpenCadre approval gate for Claude Code (PreToolUse hook). Zero dependencies.
//
// Watches Bash commands against a small set of risky rules. What happens on a
// match is up to the user (see approval-gate.config.example.json):
//   off     do nothing
//   notify  never block; record the action in OpenCadre and ping the approver (default)
//   ask     block until approved in OpenCadre; timeout / hub-down behavior configurable
//   strict  like ask, but always fail closed, no branch or default-allowlist exemptions
// Everything that matches no rule passes through untouched.
//
// Workspace policy: when a risky rule matches, the gate reads the mode an operator set on the hub
// for this project (GET /v1/clearance-policy, project = the git remote of origin). The stricter of
// the hub decision and the local decision wins, so local config can tighten a policy but never
// loosen it. Under a hub policy the built-in rules, the default allowlist and deny-on-timeout /
// deny-if-unreachable apply regardless of local overrides. The last mode read is cached in
// ~/.opencadre/clearance-policy-cache.json; when the hub can't be reached the cached mode is
// enforced (strict or ask then deny). A malformed policy response denies the command.
//
// Config (composeGateConfig in scripts/opencadre-config.mjs has the full precedence): the trusted layers merge in this
// order (later wins; allow/rules lists are combined): built-in defaults < ~/.opencadre/approval-gate.json < file at
// $OPENCADRE_GATE_CONFIG < env overrides. <project>/.opencadre/approval-gate.json comes with the repository, so it can
// only TIGHTEN them (a stricter mode, deny fallbacks, more rules); anything that would loosen them is ignored, with a
// warning on stderr.
//
// Only a PERSON's decision (or a person's standing grant) is ever printed as an allow (F7 / Q1f). onTimeout or
// onHubUnreachable "allow" is NO OPINION: the command goes back to the tool's own permission settings, which may prompt
// someone or may not (an auto-approve setting or allow rule lets it run), and the hub records a `clearance.policy_pass`,
// never an approval. Under strict, every outcome no person approved is a deny.
// Hub and key: OPENCADRE_URL + OPENCADRE_KEY, else the client's own MCP config (--client, default claude-code),
// so the hook installed by `opencadre connect` needs no environment variables.
// Env: OPENCADRE_URL, OPENCADRE_KEY (optional, see above),
//      OPENCADRE_GATE_MODE, OPENCADRE_APPROVER, OPENCADRE_APPROVAL_WAIT
//
// WHEN THE GATE ITSELF FAILS (board 70f528b2). A crash on a command the gate holds as risky is a deny in the client's
// dialect AND exit 2 on Claude Code, Codex and Cursor (crashExitFor; see `failure` below), and Cursor's entry is
// written `failClosed: true`, so there a crash, a timeout or a gate that cannot start blocks too. What still lets a
// command run, because it happens where the gate has no say:
//   - a hook TIMEOUT on Claude Code or Codex (connect gives the gate 600 s; the wait for a person ends at 540 s, inside
//     it, as the gate's own answer), or the harness killing the gate for any other reason;
//   - `node` missing on Claude Code or Codex, so nothing starts at all (a helper generation that fails to LOAD is
//     already a deny: the installed entry stub prints the gate's own deny, cli/lib/stubs.mjs);
//   - a crash on a command no built-in rule holds, before the rules have finished (exit 1, as before: Claude Code and
//     Codex run it with a hook error shown; Cursor blocks it);
//   - clients with no documented blocking exit (Qwen Code, Gemini CLI, Kilo, Amp, OpenCode): their crash behaviour is
//     unchanged.
// `opencadre doctor` reads the install, not a live run: it reports a missing gate entry (hooks partial), a Claude Code
// matcher missing a shell tool (gate_matcher=outdated), a Cursor gate without failClosed (gate_fail_closed=missing),
// and helpers that do not match the CLI (helpers=mismatch). It never starts the gate, so a gate that crashes on every
// run, or a `node` the harness cannot find, is not seen by it. Proposed: a doctor probe that pipes a risky test payload
// into the installed gate entry, against no hub, and expects a deny.
//
// --report (post-execution hook, e.g. Codex PostToolUse): the command has already run. Nothing is
// printed or blocked; each risky command is reported to POST /v1/clearances/executed, which records
// it (notify) or raises clearance.bypassed when it needed approval and had none (ask/strict).
//
// .claude/settings.json:
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [
//       { "type": "command", "command": "node examples/hooks/opencadre-approval-gate.mjs", "timeout": 600 } ] } ] } }

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve as resolvePath, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { antigravityWorkspace, composeGateConfig, GATE_DEFAULTS, headBranchOnDisk, hostGateInstalled, isBillingReadOnly, isProjectNotEnabled, NO_SESSION_ERROR, normalizeProject, PROJECT_HEADER, RESOLVE_ONLY_HEADER, resolveHub, stampActive } from "../../scripts/opencadre-config.mjs";
import { maskSecrets } from "../../scripts/opencadre-secrets.mjs";
import { parseHookInput, foreignHost, hookCommand, hookCwd, hookHost, hookSessionId, permissionOutput, silenceFor, typedShellInput, unenteredTail, waitCapFor, blockExitFor, crashExitFor, denyExitFor } from "../../scripts/opencadre-hook-dialect.mjs";

// Shared fragments for secret-file-write below: a private key of any common type, excluding its
// already-public .pub companion (copying a .pub file is routine), and a .pem file.
const PRIVATE_KEY_FILE = String.raw`id_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)`;
const PEM_FILE = String.raw`\S+\.pem\b`;

// Files that reprogram an agent's own future behavior: its standing instructions (AGENTS.md,
// CLAUDE.md, GEMINI.md), the MCP servers it will trust next session (.mcp.json, .cursor/mcp.json),
// its Claude Code settings including hook wiring (.claude/settings.json, settings.local.json), and
// the hook scripts those settings invoke -- this file's own installed copy and its sibling helpers
// under ~/.opencadre/bin/ (see docs/CLIENT-ONBOARDING.md) or a checkout's examples/hooks/. A write
// to any of these is a persistence/reprogramming vector, not a one-off destructive action: unlike
// `rm -rf`, its effect outlives the command and quietly changes what every later command is allowed
// or told to do -- including disarming this very gate by editing the hook's own script or the
// settings entry that wires it in.
// The last alternative is OpenCadre's seat records (~/.opencadre/run/): any write that names the folder, with or without
// a file name after it. It stops the obvious forms only; the records are checked again where they are read.
const AGENT_CONFIG_FILE = String.raw`(?:(AGENTS\.md|CLAUDE\.md|GEMINI\.md|(^|[\s/])\.mcp\.json|\.cursor/mcp\.json|\.claude/settings(\.local)?\.json|(opencadre-(approval-gate|wake|config|awareness|antigravity|mcp)|pure-ack)\.mjs)\b|\.opencadre[\\/]run\b)`;

const DEFAULT_RULES = [
  { category: "rm-rf", pattern: String.raw`\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b`, risk: "high" },
  { category: "force-push", pattern: String.raw`\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)`, risk: "high", branchAware: true },
  { category: "git-reset-hard", pattern: String.raw`\bgit\s+reset\s+--hard\b`, risk: "medium", branchAware: true },
  { category: "git-clean", pattern: String.raw`\bgit\s+clean\s+-[a-zA-Z]*f`, risk: "medium", branchAware: true },
  { category: "sql-drop", pattern: String.raw`\b(drop\s+(table|database|schema)|truncate\s+table)\b`, risk: "high" },
  { category: "terraform", pattern: String.raw`\bterraform\s+(apply|destroy)\b`, risk: "high" },
  { category: "kubectl-delete", pattern: String.raw`\bkubectl\s+delete\b`, risk: "high" },
  { category: "publish", pattern: String.raw`\b(npm|pnpm|yarn)\s+publish\b`, risk: "high" },
  { category: "docker-prune", pattern: String.raw`\bdocker\s+(system\s+prune|volume\s+rm)\b`, risk: "medium" },
  // Writing or changing the secrets a production deploy reads: the .env.production file itself
  // (by redirect, cp, mv or tee), or the CLI commands that set a live host's environment/config/
  // secrets store directly.
  {
    category: "prod-env-write",
    pattern: String.raw`(>\s*\S*\.env\.production\b)|(\b(cp|mv|tee)\b.*\.env\.production\b)|(\bvercel\s+env\s+(add|rm|remove)\b)|(\bfly\s+secrets\s+set\b)|(\bheroku\s+config:set\b)|(\bwrangler\s+secret\s+put\b)|(\bnetlify\s+env:set\b)|(\brailway\s+variables\b.*--set\b)|(\bgh\s+secret\s+set\b)|(\bkubectl\s+create\s+secret\b)`,
    risk: "high",
  },
  // Writing or copying a private key or credentials file out of its usual place. Scoped to a write
  // (redirect, cp, mv or tee for .env; redirect, cp, scp or rsync for a key file) so routine reads
  // (chmod, cat for inspection, ssh-keygen -f) don't trigger it. ".env" only matches the literal
  // file, not ".env.example"/".env.local"/etc., which are routine; a *.pub key is its public half,
  // also routine; and bootstrapping .env from its own example/sample/template (that exact source,
  // right after cp/mv -- not just named anywhere later in the command) is routine setup, not a
  // write of real secrets, so it's excluded even though the destination is the literal file. The
  // exclusion doesn't apply to tee, which has no source-file argument to be a template.
  {
    category: "secret-file-write",
    pattern: String.raw`(>\s*\S*(${PRIVATE_KEY_FILE}|\.pem\b))|(\b(cp|scp|rsync)\b.*\b(${PRIVATE_KEY_FILE}|${PEM_FILE}))|(>\s*\S*\.env(?!\.[a-zA-Z])\b)|(\btee\b.*\.env(?!\.[a-zA-Z])\b)|(\b(cp|mv)\s+(?!\S*\.env\.(example|sample|template)\b\s+\S*\.env(?!\.[a-zA-Z])\b(\s|$)).*\.env(?!\.[a-zA-Z])\b)`,
    risk: "high",
  },
  // Writing to a file that reprograms an agent's own (or another agent's) future instructions,
  // trusted MCP servers, or hook wiring -- see AGENT_CONFIG_FILE above. Not branch-aware: unlike a
  // force-push or a hard reset, the risk here is a live agent process picking up the rewritten
  // file from disk on its very next read (CLAUDE.md, hook config, etc. are read from the working
  // tree, not from a protected branch's history), so a feature branch is no safer than main. Scoped
  // to a write (redirect, cp/mv/tee, `sed -i`, scp/rsync) so a plain read (`cat CLAUDE.md`) or a
  // history lookup (`git log -- CLAUDE.md`) doesn't trigger it -- this catches only edits made
  // *through a shell command*; an agent that edits these files via a dedicated file-write tool
  // (e.g. Claude Code's own Edit/Write) is invisible to this hook entirely, because it is wired
  // only to the shell tools' PreToolUse (Bash and PowerShell; see examples/hooks/README.md and
  // docs/CLIENT-ONBOARDING.md) and receives no notification for other tool calls.
  {
    category: "agent-config-write",
    pattern: String.raw`(>\s*\S*${AGENT_CONFIG_FILE})|(\b(cp|mv|tee)\b.*${AGENT_CONFIG_FILE})|(\b(scp|rsync)\b.*${AGENT_CONFIG_FILE})|(\bsed\s+-i[a-zA-Z0-9.]*\b.*${AGENT_CONFIG_FILE})`,
    risk: "high",
  },
  // The records that tell OpenCadre which seat or folder a chat is: its own (~/.opencadre/run) and Antigravity's cache
  // of each folder's conversation (~/.gemini/antigravity-cli/cache/last_conversations.json). ANY command that names
  // them is held, a delete or a plain read included: rewriting or removing one can point a later clearance check at
  // another project's (laxer) policy (review of d790104, B1). No legitimate task names them.
  {
    category: "opencadre-state",
    pattern: String.raw`\.opencadre[\\/]run\b|\brun[\\/]typed\b|antigravity-cli[\\/]cache\b|last_conversations\.json\b`,
    risk: "high",
  },
  // Migration commands that discard data rather than just changing schema: full resets/rollbacks
  // and an explicit column drop, across the frameworks and tools agents most often reach for.
  {
    category: "destructive-migration",
    pattern: String.raw`(\bprisma\s+migrate\s+reset\b)|(\bprisma\s+db\s+push\b.*--force-reset\b)|(\brails\s+db:(drop|reset)\b)|(\brake\s+db:drop\b)|(\bknex\s+migrate:rollback\b.*--all\b)|(\bsequelize(-cli)?\s+db:migrate:undo:all\b)|(\bmanage\.py\s+flush\b)|(\balembic\s+downgrade\s+base\b)|(\bsupabase\s+db\s+reset\b)|(\bdrizzle-kit\s+drop\b)|(\bdrop\s+column\b)`,
    risk: "high",
  },
  // Fail-safe rule for shellNormalize() below: the command actually being invoked (the first word
  // of a simple command, past any leading `FOO=bar` assignments) is built in part or in whole from
  // an unquoted $(...) / backtick / $((...)) / bare $VAR we can't resolve ahead of time. We don't
  // know what will run, so -- rather than silently pass it through because the raw text matched
  // none of the rules above -- we treat "we can't tell what this is" as risky in its own right.
  // `pattern` is unused for this rule (see `matches()`); it's present only so the array shape and
  // the disabledCategories/user-config filtering that expect a string `pattern` keep working.
  { category: "unresolved-dynamic-command", pattern: "(?!)", risk: "high", dynamic: true },
  // Keystrokes typed into a running shell with keys that EDIT the line (backspace, Ctrl-A, arrows, escape sequences):
  // the shell runs a line the gate cannot read from the text (review of 8fe0ca9, B2). Matched on a flag, like the rule
  // above; no allowlist entry passes it.
  { category: "typed-line-editing", pattern: "(?!)", risk: "high", typedEdit: true },
  // WINDOWS-NATIVE DESTRUCTION. The rules above are POSIX, and on Windows (Codex runs PowerShell) they
  // matched `rm -rf` and nothing native: `Remove-Item -Recurse -Force`, `ri -r -fo`, `rd /s /q` and
  // `del /f /q` all passed ungated (docs/planning/LAUNCH-CLIENT-GATE.md, the Codex CLI Clearance row;
  // raised as blocking on #530 by Codex-OpenCadre-d193). A regex over the raw string cannot cover these:
  // one cmdlet has 7 names and any unambiguous prefix of each parameter, so they are matched on parsed
  // commands (psCommands below), the way `dynamic` matches on a parsed flag. The placeholder `pattern`
  // keeps the array shape the config filtering expects.
  { category: "ps-recursive-delete", pattern: "(?!)", risk: "high", psCheck: "recursive-delete" },
  { category: "opaque-shell-command", pattern: "(?!)", risk: "high", psCheck: "opaque-shell" },
  { category: "cmd-tree-delete", pattern: "(?!)", risk: "high", psCheck: "cmd-tree-delete" },
  { category: "disk-destroy", pattern: "(?!)", risk: "high", psCheck: "disk-destroy" },
];

// Deleting only well-known build/cache output is routine, not risky. Both shells: the POSIX form, and the
// PowerShell/cmd form (any Remove-Item alias, any switches, only those folder names as targets).
const BUILD_OUTPUT = String.raw`(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|__pycache__|\.pytest_cache|target|tmp)`;
const DEFAULT_ALLOW = [
  String.raw`^\s*rm\s+-[a-zA-Z]+(\s+(\./)?${BUILD_OUTPUT}/?)+\s*$`,
  String.raw`^\s*(remove-item|rm|ri|del|erase|rd|rmdir)((\s+[-/][\w:$]+)|(\s+['"]?(\.[\\/])?${BUILD_OUTPUT}[\\/]?['"]?))+\s*$`,
];

const DEFAULTS = GATE_DEFAULTS;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// The layers and their precedence are defined once, in composeGateConfig (scripts/opencadre-config.mjs), which
// `opencadre doctor` reports from too. F7 / Q1f: the repository's own file (<cwd>/.opencadre/approval-gate.json) arrives
// with the code, so it can only TIGHTEN the machine's settings; a loosening one is ignored, with a warning.
function loadConfig(cwd) {
  const { cfg, warnings } = composeGateConfig({
    home: readJson(join(homedir(), ".opencadre", "approval-gate.json")),
    repo: cwd ? readJson(join(cwd, ".opencadre", "approval-gate.json")) : {},
    envFile: process.env.OPENCADRE_GATE_CONFIG ? readJson(process.env.OPENCADRE_GATE_CONFIG) : {},
    env: process.env,
  });
  return { ...cfg, warnings };
}

const safeRegex = (source) => {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
};

// --- GuardFall-style obfuscation defense -----------------------------------------------------
//
// Every DEFAULT_RULES pattern used to be tested against the command exactly as the model wrote
// it. A real shell does not run that text as written: it strips quotes and glues adjacent
// quoted/unquoted fragments into one word, expands $IFS-based field splitting, and resolves
// backslash escapes and line continuations *before* it looks up which program to run. So
//   r'm' -rf /tmp/x            (quote-splitting)
//   rm${IFS}-rf${IFS}/tmp/x    ($IFS field-splitting)
//   git push --for''ce main   (quote-splitting a flag)
// all execute identically to `rm -rf /tmp/x` / `rm -rf /tmp/x` / `git push --force main` in any
// POSIX shell, but none contain the contiguous substring `\brm\b` or `--force\b` looks for, so the
// old raw-string regex missed all three (see the "GuardFall obfuscation" describe block in
// tests/approval-hook.test.ts for the reproduction and the regression tests). This is exactly the
// class of bypass the June 2026 GuardFall disclosure demonstrated against most agent command
// guards -- pattern-matching the string instead of tokenizing it the way a shell would.
//
// shellNormalize() below re-parses the command the way a shell's quote-removal/word-splitting
// pass would, and rules are matched against the RECONSTRUCTED text instead of the raw one. It is
// deliberately not a full POSIX parser: it does not model subshells, redirection targets, glob
// expansion, or parameter expansion with defaults (${x:-default}). Where it genuinely cannot know
// what a token resolves to -- an unquoted $(...), backtick command substitution, $((...)), or a
// bare $VAR/${VAR} (other than $IFS, which is a well-known field-splitter we *can* resolve)
// sitting in the position of the program that's actually about to run -- it does not guess. Per
// the fail-safe rule, a command whose command-word we can't resolve is treated as risky in its own
// right (category `unresolved-dynamic-command`, see DEFAULT_RULES above) rather than silently
// passed through just because the raw text didn't spell out anything we recognized. A dynamic
// fragment used only as an *argument* elsewhere in a resolvable command (e.g.
// `git push --force $(cat reason.txt)`) doesn't trigger this -- the already-resolvable `--force`
// is caught by the ordinary force-push rule, so there is nothing to fail safe about there.
//
// Known, accepted limitation: a dynamic command hidden behind a wrapper this doesn't unwrap (e.g.
// `sudo $(echo rm) -rf /`, where `sudo` -- not the dynamic part -- is the command word) is not
// flagged by this heuristic. That is a gap in *improvement*, not a regression: the raw-string
// match caught nothing there either, so behavior is unchanged, never worse.
function shellNormalize(raw) {
  const words = [];
  let cur = null; // word currently being built: { text, dynamic }
  let atCommandStart = true; // true at the very start, and right after a command-boundary operator
  let sawUnresolvedCommand = false;
  const DYNAMIC_MARK = "\u0000"; // opaque: not whitespace, not a word char, never a byte a real command contains

  const startWord = () => { if (!cur) cur = { text: "", dynamic: false }; };
  const endWord = () => {
    if (!cur) return;
    if (atCommandStart) {
      // `FOO=bar` env-assignment prefixes aren't the command word. If the "assignment" itself is
      // dynamic we can't tell it's an assignment at all, so don't give it the benefit of the doubt.
      const looksLikeAssignment = !cur.dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cur.text);
      if (!looksLikeAssignment) {
        if (cur.dynamic) sawUnresolvedCommand = true;
        atCommandStart = false;
      }
    }
    words.push(cur.text);
    cur = null;
  };
  const boundary = () => { endWord(); atCommandStart = true; };

  const n = raw.length;
  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_]/.test(c);
  let i = 0;

  // i sits on the first char of `open` (length openLen); consumes through the matching `close`,
  // tracking nesting of that same pair. Quoting inside the substitution isn't modeled -- its
  // content is opaque to us regardless (see sawUnresolvedCommand above), so under- or
  // over-consuming a stray quote inside it changes nothing about how we treat the outer command.
  function consumeBalanced(openLen, open, close) {
    i += openLen;
    let depth = 1;
    while (i < n && depth > 0) {
      if (raw.startsWith(open, i)) { depth++; i += openLen; continue; }
      if (raw.startsWith(close, i)) { depth--; i += close.length; continue; }
      i++;
    }
  }
  // Backticks aren't nestable the way $(...) is (open === close), so they need their own scan.
  function consumeBacktick() {
    i++;
    while (i < n && raw[i] !== "`") { i += raw[i] === "\\" && i + 1 < n ? 2 : 1; }
    i++;
  }

  function consumeDollar() {
    if (raw.startsWith("$((", i)) { consumeBalanced(3, "((", "))"); cur.dynamic = true; cur.text += DYNAMIC_MARK; return; }
    if (raw.startsWith("$(", i)) { consumeBalanced(2, "$(", ")"); cur.dynamic = true; cur.text += DYNAMIC_MARK; return; }
    if (raw[i + 1] === "{") {
      const close = raw.indexOf("}", i + 2);
      const name = close > -1 ? raw.slice(i + 2, close) : null;
      if (name === "IFS") { i = close + 1; endWord(); return; }
      if (name !== null) { i = close + 1; startWord(); cur.dynamic = true; cur.text += DYNAMIC_MARK; return; }
      startWord(); cur.text += "$"; i += 1; return; // unterminated ${...: '$' stands for itself
    }
    if (isIdentStart(raw[i + 1] || "")) {
      let j = i + 1;
      while (j < n && isIdent(raw[j])) j++;
      const name = raw.slice(i + 1, j);
      i = j;
      if (name === "IFS") { endWord(); return; }
      startWord(); cur.dynamic = true; cur.text += DYNAMIC_MARK; return;
    }
    startWord(); cur.text += "$"; i += 1; // bare '$' with nothing recognizable after it: literal
  }

  while (i < n) {
    const c = raw[i];
    if (c === "'") {
      startWord();
      i++;
      while (i < n && raw[i] !== "'") { cur.text += raw[i]; i++; } // single quotes: nothing is special, not even \
      i++;
      continue;
    }
    if (c === '"') {
      startWord();
      i++;
      while (i < n && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < n && '$`"\\\n'.includes(raw[i + 1])) {
          if (raw[i + 1] !== "\n") cur.text += raw[i + 1]; // \<newline> inside "..." is a line continuation: adds nothing
          i += 2;
          continue;
        }
        if (raw[i] === "$") { consumeDollar(); continue; }
        if (raw[i] === "`") { consumeBacktick(); cur.dynamic = true; cur.text += DYNAMIC_MARK; continue; }
        cur.text += raw[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "\\") {
      if (raw[i + 1] === "\n") { i += 2; continue; } // line continuation: joins the surrounding word, adds nothing
      startWord();
      if (i + 1 < n) { cur.text += raw[i + 1]; i += 2; } else { i++; }
      continue;
    }
    if (c === "$") { startWord(); consumeDollar(); continue; }
    if (c === "`") { startWord(); consumeBacktick(); cur.dynamic = true; cur.text += DYNAMIC_MARK; continue; }
    if (/\s/.test(c)) { endWord(); i++; continue; }
    if (";&|(){}<>".includes(c)) {
      // A command-boundary/redirection operator: ends whatever word was building (so quote-joining
      // never spans across one) and resets command-word detection for what follows, but the
      // character itself is kept as its own token -- some rules (prod-env-write, secret-file-write)
      // key off the literal `>` of a redirect, and dropping it would be its own regression.
      endWord();
      words.push(c);
      atCommandStart = true;
      i++;
      continue;
    }
    startWord();
    cur.text += c;
    i++;
  }
  endWord();

  return { text: words.filter((w) => w.length).join(" "), dynamicCommand: sawUnresolvedCommand };
}

// --- PowerShell and cmd.exe ------------------------------------------------------------------------
//
// Each simple command in a PowerShell (or cmd.exe) command line, as { name, args }: names lowercased,
// with any path and `.exe` stripped; args lowercased with quotes removed. Statements are split on
// `;`, `|`, `&&`, `||` and newlines, AND on `{ } ( )`, so the body of a script block or a
// subexpression (`ForEach-Object { Remove-Item … }`, `for (…) { … }`) is examined as its own command
// rather than hidden inside another's arguments. The call operators `&` and `.` are stepped over, so
// `& 'C:/…/bash.exe' -c …` names bash. A command handed to another shell as a string is examined too
// (`cmd /c "…"`, `powershell -Command "…"`), to a small fixed depth.
//
// Deliberately NOT a full PowerShell parser, like shellNormalize: it only has to find the command word
// and its switches reliably, and it errs toward seeing a command (a false positive asks a person)
// rather than missing one.
// PowerShell comments, blanked out: `<# … #>` anywhere outside quotes, and `#` to the end of the line when
// it starts a token (`a#b` is one word, not a comment). Without this, a comment that MENTIONS a delete or
// `& $cmd` was read as running it (Codex-OpenCadre-d193, #534).
function psStripComments(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "`" && quote === '"' && i + 1 < text.length) { out += c + text[++i]; continue; }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === "`" && i + 1 < text.length) { out += c + text[++i]; continue; }
    if (c === "<" && text[i + 1] === "#") {
      const end = text.indexOf("#>", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
      continue;
    }
    if (c === "#" && (out === "" || /[\s;|&{}()]$/.test(out))) {
      const end = text.indexOf("\n", i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function psSplit(text) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "`" && quote === '"' && i + 1 < text.length) { cur += c + text[++i]; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "`" && i + 1 < text.length) { cur += c + text[++i]; continue; }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(cur); cur = ""; i++; continue; }
    if (";|\n\r{}()".includes(c)) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function psWords(statement) {
  const words = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if (quote) {
      if (c === "`" && quote === '"' && i + 1 < statement.length) { cur += statement[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "`" && i + 1 < statement.length) { cur += statement[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) words.push(cur); cur = ""; started = false; continue; }
    cur += c;
    started = true;
  }
  if (started) words.push(cur);
  return words;
}

const commandName = (word) => word.replaceAll("\\", "/").split("/").pop().toLowerCase().replace(/\.exe$/, "");

// An assignment in front of a command: `$x = …`, `$x=…`, `$x += …`, `[array]$x = …`, `$a = $b = …`. The
// command is the right-hand side, so a check that read the first word saw `$x` and missed
// `$removed = Remove-Item -Recurse …` (Codex-OpenCadre-d193, #534). Returns the words after it.
const ASSIGN_TARGET = /^(\[[^\]]+\])*\$[^\s=]+$/;
const ASSIGN_OP = /^([-+*/%]|\?\?)?=$/;
const ASSIGN_JOINED = /^(\[[^\]]+\])*\$[\w:{}?.]+?([-+*/%]|\?\?)?=(.*)$/;
function dropAssignments(words) {
  for (;;) {
    if (/^\[[^\]]+\]$/.test(words[0] ?? "") && ASSIGN_TARGET.test(words[1] ?? "")) words = words.slice(1);
    if (ASSIGN_TARGET.test(words[0] ?? "") && ASSIGN_OP.test(words[1] ?? "")) { words = words.slice(2); continue; }
    const joined = ASSIGN_JOINED.exec(words[0] ?? "");
    if (joined && !/^=/.test(joined[3])) { words = joined[3] ? [joined[3], ...words.slice(1)] : words.slice(1); continue; }
    return words;
  }
}

function psCommands(text, depth = 0) {
  const out = [];
  for (const statement of psSplit(psStripComments(text))) {
    let words = dropAssignments(psWords(statement));
    // The call and dot-source operators: `& 'path\to\tool.exe' args` runs tool.exe.
    if ((words[0] === "&" || words[0] === ".") && words.length > 1) words = words.slice(1);
    if (!words.length) continue;
    const name = commandName(words[0]);
    const args = words.slice(1);
    out.push({ name, args: args.map((a) => a.toLowerCase()) });
    if (depth >= 3) continue;
    // A command handed to another shell as a string runs too.
    const nested = (flag) => {
      const at = args.findIndex((a) => flag.test(a));
      if (at >= 0 && at + 1 < args.length) out.push(...psCommands(args.slice(at + 1).join(" "), depth + 1));
    };
    if (name === "cmd") nested(/^\/[ck]$/i);
    if (name === "bash" || name === "sh" || name === "zsh") nested(/^-[a-z]*c[a-z]*$/i);
    if (name === "powershell" || name === "pwsh") {
      nested(/^-(c|co|com|comm|comma|comman|command)$/i);
      // PowerShell accepts abbreviated parameter names, including -e, -en and the -ec alias;
      // slash and double-dash prefixes are accepted on the Windows host too. An unreadable
      // payload is held as opaque instead of being mistaken for an ordinary harmless argument.
      const encodedFlag = (arg) => {
        const m = /^[-/]{1,2}([a-z]+)(?::(.+))?$/i.exec(arg);
        return m && ("encodedcommand".startsWith(m[1].toLowerCase()) || m[1].toLowerCase() === "ec") ? m : null;
      };
      const encodedAt = args.findIndex(encodedFlag);
      if (encodedAt >= 0) {
        const encoded = encodedFlag(args[encodedAt])?.[2] ?? args[encodedAt + 1];
        const bytes = typeof encoded === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ? Buffer.from(encoded, "base64") : null;
        const canonical = bytes?.toString("base64") === encoded;
        if (!canonical || !bytes.length || bytes.length % 2) out.push({ name: "__opencadre_opaque_shell__", args: [] });
        else out.push(...psCommands(bytes.toString("utf16le"), depth + 1));
      }
    }
  }
  return out;
}

// Remove-Item under every name PowerShell accepts for it, and cmd.exe's own deletes.
const REMOVE_ITEM = new Set(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"]);
// -Recurse and every unambiguous prefix of it (no other Remove-Item parameter starts with r), optionally
// `:$true`. `-Recurse:$false` is not a recursive delete.
const RECURSE = /^-r(e(c(u(r(se?)?)?)?)?)?(:\$true)?$/;
const PS_CHECKS = {
  "opaque-shell": (cmds) => cmds.some((c) => c.name === "__opencadre_opaque_shell__"),
  "recursive-delete": (cmds) => cmds.some((c) => REMOVE_ITEM.has(c.name) && c.args.some((a) => RECURSE.test(a))),
  "cmd-tree-delete": (cmds) => cmds.some((c) => ((c.name === "rd" || c.name === "rmdir") && c.args.includes("/s"))
    || ((c.name === "del" || c.name === "erase") && c.args.some((a) => a === "/s" || a === "/f"))),
  "disk-destroy": (cmds) => cmds.some((c) => ["format-volume", "clear-disk", "initialize-disk", "remove-partition"].includes(c.name)),
};

// A PowerShell command whose invoked program cannot be known ahead of time. In PowerShell `$x = …` is
// an ASSIGNMENT and the backtick is its escape character, so the POSIX reading ("a `$` or a backtick in
// command position is dynamic") flagged ordinary scripts. MEASURED 2026-09-22: at least 42 of 50
// `approval.noted` events in one hour were one Codex chat's harmless read-only PowerShell, all
// `unresolved-dynamic-command`. What really hides the program in PowerShell is invoking a computed
// value: `& $cmd`, `& (…)`, `. $script`, Invoke-Expression/iex, or Start-Process $x.
function psDynamic(text) {
  return /(^|[;|{(\n\r=]|&&|\|\|)\s*[&.]\s*[$(]/.test(psStripComments(text))
    || psCommands(text).some((c) => c.name === "iex" || c.name === "invoke-expression"
      || (c.name === "start-process" && !isLiteralProgram(startProcessTarget(c.args))));
}

// The program Start-Process runs: the -FilePath value (any prefix of it, or its aliases -Path/-PSPath,
// with or without `:`), else the first positional argument. Reading only args[0] let
// `Start-Process -FilePath $exe` through as a literal, since args[0] was `-FilePath` (Codex-OpenCadre-d193,
// #534). The switches take no value; every other parameter takes one, which is skipped.
const START_PROCESS_SWITCHES = ["loaduserprofile", "lup", "nonewwindow", "nnw", "passthru", "wait", "usenewenvironment"];
function startProcessTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) return a;
    const colon = a.indexOf(":");
    const param = (colon < 0 ? a : a.slice(0, colon)).slice(1);
    const value = colon < 0 ? undefined : a.slice(colon + 1);
    if ((param && "filepath".startsWith(param)) || param === "path" || param === "pspath") return value ?? args[i + 1];
    if (param && START_PROCESS_SWITCHES.some((s) => s.startsWith(param))) continue;
    if (value === undefined) i++;
  }
  return undefined;
}
// A value cut off by a `(` split, splatted (`@args`) or held in a variable is not a known program.
const isLiteralProgram = (target) => target !== undefined && !/^[$(@]/.test(target);

const MODES = ["off", "notify", "ask", "strict"];
// How long to wait for the hub's policy before treating the hub as unreachable. Overridable so tests against a hub on a
// busy machine don't read a slow answer as a dead hub.
const POLICY_TIMEOUT_MS = Number(process.env.OPENCADRE_POLICY_TIMEOUT_MS) > 0 ? Number(process.env.OPENCADRE_POLICY_TIMEOUT_MS) : 3000;

let branchCache;
function currentBranch(cwd) {
  if (branchCache !== undefined) return branchCache;
  return (branchCache = readBranch(cwd));
}

function readBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true }).toString().trim();
  } catch {
    return null;
  }
}

let diskBranch;
/** What git would print for the branch, read from the repository's files; undefined when only git can say. */
function branchOnDisk(cwd) {
  diskBranch ??= { value: headBranchOnDisk(cwd) };
  return diskBranch.value;
}

/** A branch-aware rule is exempt when we're on an unprotected branch and the
 * command doesn't name a protected one (e.g. `git push --force origin main`). */
function branchExempt(command, cwd, protectedBranches) {
  const exempt = (branch) => {
    if (!branch || branch === "HEAD" || protectedBranches.includes(branch)) return false;
    return !protectedBranches.some((b) => new RegExp(String.raw`(^|[\s:/])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\s|$)`).test(command));
  };
  // The branch is read from disk first, which saves starting git (about 60 ms on Windows). The disk reader gives git's
  // own answer whenever git opens the repository, and git refusing it (safe.directory ownership, an unknown extension,
  // no git, a timeout) is a null branch, which is never exempt. So a "not exempt" from the disk is final, and only an
  // exemption, the answer that lets a command through, is confirmed by git exactly as before.
  const onDisk = branchOnDisk(cwd);
  if (onDisk !== undefined && !exempt(onDisk)) return false;
  return exempt(currentBranch(cwd));
}

const REPORT = process.argv.includes("--report");
// Which harness this copy of the gate was installed for. It decides the answer's dialect (Claude Code and
// Codex read `hookSpecificOutput`; Cursor reads a flat `permission`), where the command sits in the
// payload, and which shell reads it (opencadre-hook-dialect.mjs).
const gateClient = process.argv.includes("--client") ? process.argv[process.argv.indexOf("--client") + 1] : "claude-code";
// Windsurf and Devin run a command whose pre-hook exits with anything but 2, a crash (exit 1) included, so there a
// crash here blocks instead (reviews of 03d4382, S2, and 47dab9a, S1): the dialect row's `blockExit`. Written
// synchronously: an exit right after an asynchronous write to a pipe can lose it.
const BLOCK_EXIT = blockExitFor(gateClient);
const DENY_EXIT = denyExitFor(gateClient);
if (BLOCK_EXIT) {
  const crashed = (err) => {
    try {
      writeSync(2, `OpenCadre approval gate failed (${err?.message ?? err}), so this command was blocked.\n`);
    } catch { /* stderr gone: still block */ }
    process.exit(BLOCK_EXIT);
  };
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
}

// Who is asking, in the words the approver reads.
const GATE_CLIENT_LABELS = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", antigravity: "Antigravity", gemini: "Gemini CLI", qwen: "Qwen Code", amp: "Amp", kilo: "Kilo Code", cline: "Cline", devin: "Devin", droid: "Factory Droid", crush: "Crush", vibe: "Mistral Vibe", grok: "Grok Build", goose: "Goose", copilot: "Copilot CLI", windsurf: "Windsurf" };

// `provenance` is who stands behind an allow: "person" only for a decision a PERSON made on this command (the hub's row
// names them, `decided_by_person_id`, migration 53), "grant" for a person-issued standing grant that auto-approved it
// (`decided_via: "grant"`: person-issued, but not a fresh decision on this command). Never inferred from an approved
// status alone: an approved row with no person is denied outright (end of the ask path). Every dialect prints an allow
// with no provenance (a policy fallback, onTimeout / onHubUnreachable "allow") as NO OPINION (F7 / Q1f,
// permissionOutput), so the gate never switches off a tool's own permission step for a command no person approved.
// Typed shell input: what the decision does to the record of what is typed but unentered (set below).
let commitTyped = () => {};
let typedEditing = false;
// Typed shell input: every line the shell may run, each judged ON ITS OWN instead of `command` (which is what the
// approver reads): one version's open quote or trailing backslash must not swallow the next (review of 1485dfe, S1).
let typedJudged = null;
const emit = (permissionDecision, permissionDecisionReason, { provenance = null } = {}) => {
  commitTyped(permissionDecision);
  // Windsurf reads no hook output: a pre-hook blocks only by exiting 2, and stderr is the message it shows.
  if (gateClient === "windsurf") {
    if (permissionDecision === "deny") {
      writeSync(2, `${permissionDecisionReason || "Blocked by OpenCadre."}\n`);
      process.exit(2);
    }
    process.exit(0);
  }
  // Where a JSON deny can be overridden by an earlier hook's allow (denyExit: Droid), a deny is an exit code, with the
  // reason on stderr, which blocks whatever came before.
  if (DENY_EXIT && permissionDecision === "deny") {
    try {
      writeSync(2, `${permissionDecisionReason || "Blocked by OpenCadre."}\n`);
    } catch { /* stderr gone: still block */ }
    process.exit(DENY_EXIT);
  }
  const said = permissionOutput(gateClient, permissionDecision, permissionDecisionReason, { provenance });
  // Where a lost answer lets the command run (blockExit: Devin), the answer is written synchronously before exiting.
  if (BLOCK_EXIT) {
    try {
      if (said) writeSync(1, said);
    } catch {
      if (permissionDecision === "deny") process.exit(BLOCK_EXIT);
    }
    process.exit(0);
  }
  // Cursor reads this JSON as the command decision. Do not exit before a piped stdout write flushes.
  writeSync(1, said);
  process.exit(0);
};
// "No opinion": nothing for Claude Code and Codex, `{}` for Cursor, which logs an empty answer as a failed
// hook run and blocks the command on a non-JSON one.
const passThrough = () => {
  commitTyped("allow");
  const quiet = silenceFor(gateClient);
  if (quiet) process.stdout.write(quiet);
  process.exit(0);
};

// THE GATE'S OWN FAILURE ON A RISKY COMMAND (board 70f528b2). Claude Code, Codex and Cursor RUN a command whose
// pre-hook crashes: exit 1 with a stack trace is a non-blocking error to the first two, and to Cursor unless its entry
// says `failClosed`. Before this, a hub answer the gate could not read, or a structurally malformed approval-gate.json
// (`"protectedBranches": 5`), crashed the gate and the risky command ran. Now, for those three clients (crashExitFor),
// an uncaught throw or rejection on a command this run holds as risky answers with the dialect's deny AND exit 2, which
// each of them blocks on whatever was printed. What counts as risky at the moment of the crash:
//   - the rules already matched it (`failure.risky`, set right after the classification below);
//   - the rules had not finished: the BUILT-IN rules decide on their own, through the same matcher when the command's
//     views were read (`failure.matches`), else on the command's raw text. A command they do not hold is not known to
//     be risky, so it keeps the old crash (exit 1: Claude Code and Codex run it with a hook error shown; Cursor blocks
//     it, because connect writes `failClosed: true` on the gate). A crash before the command is read is the same.
// After a notify decision the gate has already decided to let the command run, so a crash while recording it keeps
// that decision (`failure.passes`). --report and --typed-commit run after the command: nothing is left to block.
// The harnesses with a `blockExit` keep their own handler above, which blocks on every crash.
const CRASH_EXIT = crashExitFor(gateClient);
const failure = { command: undefined, matches: undefined, risky: false, passes: false };
if (!BLOCK_EXIT && CRASH_EXIT && !REPORT && !process.argv.includes("--typed-commit")) {
  const builtInRisky = () => {
    try {
      if (failure.matches) return DEFAULT_RULES.some(failure.matches);
      return typeof failure.command === "string"
        && DEFAULT_RULES.some((r) => !r.dynamic && !r.psCheck && !r.typedEdit && Boolean(safeRegex(r.pattern)?.test(failure.command)));
    } catch {
      return false;
    }
  };
  // THE HANDLER MUST NOT FAIL ITSELF (Olive's review of fd30271a, P2). Whatever was thrown is attacker-shaped: an
  // object with no prototype, a `message` that cannot become a string, a `message` getter that throws. Formatting one
  // inside this handler threw again, and Node ended the run with exit 7 and an empty stdout: no deny, so Claude Code and
  // Codex ran the command. So the deny never depends on the thrown value: its fixed text and its printed answer are
  // built HERE, before any crash, every read of the thrown value is guarded, and the blocking exit is in a `finally`.
  const FIXED_REASON = "OpenCadre approval gate failed on a command it holds as risky, so the command was blocked (fail closed). Ask the user before trying another way.";
  const FIXED_DENY = permissionOutput(gateClient, "deny", FIXED_REASON);
  /** The thrown value's message as text, or null when reading or converting it throws. */
  const describe = (err) => {
    try {
      return String(err?.message ?? err).slice(0, 200);
    } catch {
      return null;
    }
  };
  const crashed = (err) => {
    // Decided first, from this run's own state only (never from `err`), so a benign command's crash is never a deny.
    let risky = true;
    try {
      if (failure.passes) {
        risky = false;
        passThrough();
      }
      risky = failure.risky || builtInRisky();
    } catch {
      if (failure.passes) process.exit(0);
    }
    if (!risky) {
      // Not known to be risky: the crash Node would have printed, and its exit code.
      try {
        writeSync(2, `${err?.stack ?? err}\n`);
      } catch { /* stderr gone, or the value cannot be printed */ }
      process.exit(1);
    }
    try {
      const detail = describe(err);
      const reason = detail === null ? FIXED_REASON
        : `OpenCadre approval gate failed (${detail}) on a command it holds as risky, so the command was blocked (fail closed). Ask the user before trying another way.`;
      try {
        commitTyped("deny");
      } catch { /* the typed record stays as it was: stricter */ }
      let said = FIXED_DENY;
      try {
        said = permissionOutput(gateClient, "deny", reason);
      } catch { /* the fixed answer */ }
      try {
        writeSync(1, said);
      } catch { /* stdout gone: the exit code still blocks */ }
      try {
        writeSync(2, `${said === FIXED_DENY ? FIXED_REASON : reason}\n`);
      } catch { /* stderr gone: still block */ }
    } finally {
      process.exit(CRASH_EXIT);
    }
  };
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
}

/** Where this session's record of what is typed into one shell lives. */
function typedRecord(typed) {
  const dir = join(process.env.OPENCADRE_HOOK_HOME || homedir(), ".opencadre", "run", "typed");
  const key = createHash("sha256").update(`${gateClient}\n${hookSessionId(input, gateClient) ?? ""}\n${typed.shell}`).digest("hex").slice(0, 32);
  return { dir, file: join(dir, `${key}.txt`) };
}
/** The record: `line`, what the shell is known to hold unentered (confirmed by the post-tool hook), and `pending`,
 * writes the gate let through that have not been confirmed to run (the tool or its user may still refuse them). Each
 * `edits` says a line-editing key is in it. A missing file is an empty record; one that does not parse throws. */
function readTyped(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { line: "", edits: false, pending: [] };
    throw err;
  }
  const rec = JSON.parse(text);
  if (typeof rec?.line !== "string" || !Array.isArray(rec.pending) || !rec.pending.every((p) => typeof p?.text === "string")) throw new Error("bad record");
  return { line: rec.line, edits: rec.edits === true, pending: rec.pending };
}
function storeTyped(file, rec) {
  if (rec.line || rec.pending.length) writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  else if (existsSync(file)) unlinkSync(file);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try {
  input = parseHookInput(raw);
} catch {
  // Cursor's beforeShellExecution hook also protects shell commands. If its input cannot
  // be parsed, the gate cannot classify the command, so deny it instead of passing through.
  // Windsurf and Devin use their blocking exit code for the same case.
  if ((BLOCK_EXIT || gateClient === "cursor" || gateClient === "codex") && !process.argv.includes("--typed-commit"))
    emit("deny", "OpenCadre approval gate: could not read this hook's input, so the command was blocked.");
  passThrough();
}
// `--typed-commit`, the post-tool hook on the tools that type into a running shell: the write RAN, so the record keeps
// only what is still unentered (a line ending in a backslash goes on). Never a decision; says nothing.
if (process.argv.includes("--typed-commit")) {
  const typed = typedShellInput(input);
  if (typed && !typed.interrupt && typeof typed.text === "string") {
    try {
      const { file } = typedRecord(typed);
      const rec = readTyped(file);
      // The first unconfirmed write with this text RAN. Writes reach the shell in order, so it joins the confirmed line
      // only once every earlier one has too; until then it is marked and stays in place, in every version judged
      // (review of 1485dfe, S2).
      const at = rec.pending.findIndex((p) => p.text === typed.text && !p.ran);
      if (at >= 0) {
        const pending = rec.pending.map((p, i) => (i === at ? { ...p, ran: true } : p));
        let { line, edits } = rec;
        while (pending.length && pending[0].ran) {
          const ran = pending.shift();
          line = unenteredTail(line + ran.text);
          edits = Boolean(line) && (edits || ran.edits);
        }
        storeTyped(file, { line, edits, pending });
      }
    } catch { /* no record, or one that does not parse: the gate denies on it */ }
  }
  const quiet = silenceFor(gateClient);
  if (quiet) process.stdout.write(quiet);
  process.exit(0);
}
// Installed for one harness and running inside another: Cursor runs Claude Code's hooks by default, AND honours
// their nested permissionDecision, so on a machine with both this Claude Code gate would hold a Cursor chat's
// command a second time, as a Claude Code session, beside the gate installed for Cursor itself. It stands down
// ONLY when the host's own gate is installed (hostGateInstalled): on a machine where just Claude Code is connected
// this copy is the only thing holding a risky command in a Cursor chat, and it keeps doing so (review of 7948fb9,
// B1). Standing down, it answers in the host's own "no opinion".
const host = foreignHost(gateClient, input);
if (host && hostGateInstalled(host)) {
  const quiet = silenceFor(host);
  if (quiet) process.stdout.write(quiet);
  process.exit(0);
}
// Codex passes the command as an argv array (e.g. ["bash", "-lc", "rm -rf x"]); Cursor's
// beforeShellExecution puts it at the top of the payload.
let command = hookCommand(input);
// Keystrokes typed into a running shell: the shell runs everything typed since its last Enter as ONE line, so a
// command split across writes (`r`, then `m -rf ./src<CR>`) is judged whole (reviews of 3a79037, 8fe0ca9, c6edd89).
// What was typed is kept per session and shell in ~/.opencadre/run/typed (the `opencadre-state` rule holds any command
// naming it).
//   - Writes to one shell are decided one at a time (a lock); one that cannot take it in time is denied.
//   - Before the decision the record gets this write appended; a deny puts it back (the write never reached the shell).
//     It is trimmed to what is still unentered only AFTER the write ran (`--typed-commit`, the post-tool hook), never
//     on the gate's say-so: the tool or its user may still refuse the write.
//   - Ctrl-C alone adds nothing and leaves the record as it is (the interrupt key can be remapped); a write with
//     line-editing keys is judged risky on its own. A record that cannot be read or written denies the write.
const typedIn = typedShellInput(input);
if (typedIn?.interrupt) passThrough();
if (gateClient === "codex" && input?.tool_name === "write_stdin" && typedIn && !typedIn.shell && typedIn.text)
  emit("deny", "OpenCadre approval gate: this terminal write has no session id, so it was blocked.");
if (typedIn && typeof command === "string") {
  const failTyped = () => emit("deny", "OpenCadre approval gate: could not keep track of what was typed into this shell, so this input was blocked. Ask the user before trying another way.");
  const { dir, file } = typedRecord(typedIn);
  const lock = `${file}.lock`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    failTyped();
  }
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let locked = false;
  for (let i = 0; i < 100 && !locked; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      locked = true;
    } catch {
      // A lock whose process is gone is stale; it is removed only if it still names that process.
      let holder = "";
      try {
        holder = readFileSync(lock, "utf8");
      } catch { /* just released */ }
      let alive = true;
      try {
        if (/^\d+$/.test(holder)) process.kill(Number(holder), 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        try {
          if (readFileSync(lock, "utf8") === holder) unlinkSync(lock);
        } catch { /* taken by another */ }
      } else {
        sleep(50);
      }
    }
  }
  if (!locked) emit("deny", "OpenCadre approval gate: another input to this shell is still being decided, so this one was blocked. Try again once it is answered.");
  process.on("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch { /* already gone */ }
  });
  let rec;
  try {
    rec = readTyped(file);
  } catch {
    failTyped();
  }
  // Every way the unconfirmed writes may have gone (each ran or was refused, in order) is a line the shell may run; one
  // confirmed out of order is in every version.
  if (rec.pending.filter((p) => !p.ran).length > 4) emit("deny", "OpenCadre approval gate: several earlier inputs to this shell were never confirmed to run, so OpenCadre cannot tell what it holds and this one was blocked. Start a new shell.");
  const variants = [];
  const open = rec.pending.map((p, i) => (p.ran ? -1 : i)).filter((i) => i >= 0);
  for (let mask = 0; mask < 1 << open.length; mask++) {
    const kept = rec.pending.filter((p, i) => p.ran || (mask & (1 << open.indexOf(i))));
    variants.push(rec.line + kept.map((p) => p.text).join("") + command);
  }
  const shown = variants[variants.length - 1];
  // The full version first: it is what the approver reads and what the branch check uses.
  typedJudged = variants.reverse();
  typedEditing = typedIn.edits || rec.edits || rec.pending.some((p) => p.edits);
  command = shown;
  try {
    storeTyped(file, { ...rec, pending: [...rec.pending, { text: typedIn.text, edits: typedIn.edits }] });
  } catch {
    failTyped();
  }
  commitTyped = (decision) => {
    commitTyped = () => {};
    if (decision !== "deny") return;
    try {
      storeTyped(file, rec);
    } catch { /* left as it was: stricter */ }
  };
}
if (typeof command !== "string" && ((gateClient === "copilot" && /^(write_)?(bash|powershell)$/.test(String(input?.toolName ?? "")))
  || (gateClient === "windsurf" && input?.agent_action_name === "pre_run_command")
  // Cline's run_commands likewise (review of 2ff9038, B1), and Devin's two shell tools (review of 47dab9a, B1).
  || (gateClient === "cline" && input?.tool_call?.name === "run_commands")
  || (gateClient === "devin" && /^(exec|write_to_process)$/.test(String(input?.tool_name ?? "")))
  || (gateClient === "codex" && /^(exec_command|write_stdin)$/.test(String(input?.tool_name ?? "")))
  || (gateClient === "droid" && input?.tool_name === "Execute")
  || (gateClient === "crush" && input?.tool_name === "bash")
  || (gateClient === "vibe" && input?.tool_name === "bash"))) {
  emit("deny", "OpenCadre approval gate: could not read this shell command, so it is blocked. Ask the user before trying another way.");
}
if (typeof command !== "string") passThrough();
failure.command = command;
// Cursor names the chat's folder in `workspace_roots` and runs this hook from ~/.cursor.
const cwd = hookCwd(input);
// Where the command itself runs, when the tool says (Kilo's `workdir`, which its bash tool tells the model to use instead
// of `cd`). The POLICY stays the session's folder; only the branch check reads this one, because `git reset --hard` is
// exempt or not by the branch it runs on. A folder outside the session's is never exempt (review of 91c617a, S1).
// Crush's bash names it `working_dir` (review of e6c51ae, B1): read either, since a folder the model names can only
// make the check stricter.
const commandWorkdir = [input?.tool_input?.workdir, input?.tool_input?.working_dir].find((d) => typeof d === "string" && d);
const commandDir = commandWorkdir ? resolvePath(cwd, commandWorkdir) : cwd;
const commandDirInside = commandDir === cwd || commandDir.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep);

// Rules are matched against the shell's-eye view of the command (quotes removed, $IFS-splitting
// resolved, escapes/line-continuations resolved), not the raw text -- see shellNormalize() above.
// `command` itself is untouched and keeps flowing to masking/reporting/branchExempt below: what
// gets sent to the hub and shown to the operator should still read like what was actually typed.
// WHICH SHELL RUNS THIS. Codex on Windows runs its commands in PowerShell (MEASURED 2026-09-22: the
// commands in its timeline were PowerShell, e.g. `$lines = @(gh api …)` and `& 'C:/…/bash.exe' -c …`);
// Claude Code's Bash tool runs a POSIX shell. OPENCADRE_GATE_SHELL overrides, for tests and odd setups.
// Antigravity runs `run_command` through PowerShell on Windows too (UNMEASURED; same reasoning). Gemini CLI's
// run_shell_command does (its getShellConfiguration picks pwsh or powershell.exe on Windows; read in 0.61.0).
// Cursor's agent terminal on Windows is PowerShell by default too (UNMEASURED on a real install; the
// Windows-native checks below run in both shells whichever is chosen).
const SHELL = ["powershell", "posix"].includes(process.env.OPENCADRE_GATE_SHELL)
  ? process.env.OPENCADRE_GATE_SHELL
  : gateClient === "copilot" && typeof input?.toolName === "string"
    // Copilot says which shell runs the command.
    ? (["powershell", "write_powershell"].includes(input.toolName) ? "powershell" : "posix")
  // Claude Code's PowerShell tool (Windows) says so the same way, in the Claude dialect's `tool_name`, and sends its
  // command in `tool_input.command` like Bash (MEASURED on claude.exe 2.1.284, F8). Its Bash tool stays POSIX.
  : input?.tool_name === "PowerShell" ? "powershell"
  : ["codex", "cursor", "antigravity", "gemini", "qwen", "windsurf", "kilo", "cline"].includes(gateClient) && process.platform === "win32" ? "powershell" : "posix";
// In PowerShell a comment never runs, so the POSIX rules read the command with its comments blanked:
// `Get-Date # rm -rf C:\work\old` is not an rm -rf (Codex-OpenCadre-d193, #534).
// One view per version of the line (typed shell input may have several); a rule matches if it matches any of them.
const views = (typedJudged ?? [command]).map((text) => {
  const normalized = shellNormalize(SHELL === "powershell" ? psStripComments(text) : text);
  return { resolved: normalized.text, dynamic: SHELL === "powershell" ? psDynamic(text) : normalized.dynamicCommand, ps: psCommands(text) };
});
const resolvedCommand = views[0].resolved;
// The Windows-native destructive checks run in BOTH shells: a POSIX command can hand one to PowerShell
// (`pwsh -c "Remove-Item -Recurse …"`), and cmdlet names collide with nothing in bash. The dynamic
// reading is per shell, since that is where the two disagree.

// `dynamic` rules (currently just unresolved-dynamic-command) don't have a regex to run at all --
// their pattern field is a placeholder (see DEFAULT_RULES above) -- they match on the precomputed
// dynamicCommand flag instead.
// `psCheck` rules (the Windows-native ones) match on the parsed PowerShell/cmd commands the same way.
// Defined before the config is read, so a crash while reading it still classifies with the built-in rules (`failure`).
const matches = (r) => (r.typedEdit ? typedEditing
  : views.some((v) => (r.dynamic ? v.dynamic
    : r.psCheck ? Boolean(PS_CHECKS[r.psCheck]?.(v.ps))
    : !!safeRegex(r.pattern)?.test(v.resolved))));
failure.matches = matches;

const cfg = loadConfig(cwd);
// An unrecognised local mode keeps its old meaning: held for approval like ask.
const localMode = MODES.includes(cfg.mode) ? cfg.mode : "ask";

const localRules = [...(cfg.useDefaultRules ? DEFAULT_RULES : []), ...cfg.rules]
  .filter((r) => r && typeof r.pattern === "string" && !cfg.disabledCategories.includes(r.category));
// Nothing risky under either rule set: no hub call, no git call.
if (!localRules.some(matches) && !DEFAULT_RULES.some(matches)) passThrough();
// Risky: from here on, the gate failing is never a reason for this command to run (see `failure` above).
failure.risky = true;

/** What one mode and set of knobs does with this command: pass, notify, or ask (with its fallbacks). */
function plan(mode, knobs) {
  if (mode === "off") return { action: "pass", rank: 0 };
  const matched = knobs.rules.find(matches);
  if (!matched) return { action: "pass", rank: 0 };
  const allow = [...(knobs.useDefaultAllowlist && mode !== "strict" ? DEFAULT_ALLOW : []), ...knobs.allow];
  // Typed shell input is never allowlisted: what it runs depends on what was typed before it.
  if (!matched.typedEdit && typedJudged === null && allow.some((a) => typeof a === "string" && safeRegex(a)?.test(command))) return { action: "pass", rank: 0 };
  // resolvedCommand here too: an obfuscated `git push --force origin ma''in` should still be
  // recognized as naming the protected branch, the same way the rule above sees the flag.
  if (matched.branchAware && mode !== "strict" && commandDirInside && branchExempt(resolvedCommand, commandDir, knobs.protectedBranches)) return { action: "pass", rank: 0 };
  if (mode === "notify") return { action: "notify", rank: 1, matched };
  const strict = mode === "strict";
  return {
    action: "ask", rank: 2, matched,
    onTimeout: strict ? "deny" : knobs.onTimeout,
    onHubUnreachable: strict ? "deny" : knobs.onHubUnreachable,
  };
}

/** The stricter of two plans; when both hold for approval, a deny fallback on either side wins. */
function stricter(a, b) {
  const [hi, lo] = b.rank > a.rank ? [b, a] : [a, b];
  if (hi.action !== "ask" || lo.action !== "ask") return hi;
  const deny = (x, y) => (x === "allow" && y === "allow" ? "allow" : "deny");
  return { ...hi, onTimeout: deny(hi.onTimeout, lo.onTimeout), onHubUnreachable: deny(hi.onHubUnreachable, lo.onHubUnreachable) };
}

const clientFlag = process.argv.indexOf("--client");
// A named agent for the folder wins; else this machine's device credential acts for this session (hook session_id).
// OpenCode can ask permission before its first MCP call. Create that chat session now so the hub policy is read for the correct project instead of treating a missing session as policy-off.
const gateSessionId = hookSessionId(input, gateClient);
const hub = resolveHub({ client: clientFlag > -1 ? process.argv[clientFlag + 1] : "claude-code", cwd, sessionId: gateSessionId, create: gateClient === "opencode" });
const base = (hub.base || "").replace(/\/$/, "");
// OpenCadre is set up for this chat: a hub and key, or a device credential whose project list does not have this folder
// (resolveHub's notEnabled). The guards below that block a command because the PROJECT cannot be identified must hold
// in both cases -- a folder that cannot be identified is, by construction, one the list cannot have.
const openCadreHere = Boolean(hub.base && hub.key) || hub.notEnabled === true;
const key = hub.key;
// x-opencadre-approval-statuses: this hook knows "withdrawn" and denies on it. Without it the hub reports a withdrawn
// request as "denied", for hooks from before that status that would otherwise fall through to onTimeout (#780).
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", "x-opencadre-approval-statuses": "withdrawn", ...hub.headers };
/** Set when the hub has no session for this chat yet (a device credential's resolve-only request). */
let noSession = false;
/** Set once the hub has answered anything over HTTP in this run: after that, no failure is "the hub is unreachable". */
let hubAnswered = false;
/** Set once the hub has answered this run's policy read with a valid mode: the hub is reachable as this chat. */
let policyRead = false;
// Copilot CLI: a subagent runs under a session id of its own that no MCP process opened, so a lookup finds no agent and
// its risky command would pass (review of 3f5e2a1, B2). For a command a hub rule would hold, the gate opens that
// session's seat and asks as it. Only then: every other hook stays a lookup, so a read-only subagent adds no agent to
// the roster (review of a7db951, B2).
// Windsurf: its conversations have no identity anywhere else (no MCP call names one), so a risky command's conversation
// becomes an agent of its own, the same way.
// Codex passive hooks only resolve. A trusted, identified chat may open its own seat here to
// REQUEST clearance before its first MCP call. Classification never grants clearance, and
// reports/missing ids/untrusted stamps cannot manufacture another identity.
const OPEN_SEAT_WHEN_RISKY = gateClient === "copilot" || gateClient === "windsurf"
  || (!REPORT && gateClient === "codex" && typeof gateSessionId === "string" && gateSessionId.trim() !== "" && stampActive({ client: "codex" }));
let seatOpened = false;

function projectKey() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true }).toString().trim();
    return normalizeProject(remote) ?? "";
  } catch {
    return "";
  }
}
// One `git remote get-url` per run: the policy read, its retry after a seat is opened and the policy-pass records all
// name the same project, and each git start costs about 60 ms on Windows.
let projectKeyMemo;
const projectOf = () => (projectKeyMemo ??= projectKey());

const cacheFile = join(process.env.OPENCADRE_HOOK_HOME || homedir(), ".opencadre", "clearance-policy-cache.json");
const readCache = () => {
  const cache = readJson(cacheFile);
  return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
};

/** The hub's mode for this project: fresh, else the last one read, else off (no policy known). */
async function hubMode() {
  if (!base || !key) return "off";
  const project = projectOf();
  const cacheKey = `${base} ${project}`;
  const cached = () => (MODES.includes(readCache()[cacheKey]?.mode) ? readCache()[cacheKey].mode : "off");
  const deviceCacheKey = `${cacheKey} ${hub.headers?.[PROJECT_HEADER] ?? ""}`;
  let res;
  try {
    res = await fetch(`${base}/v1/clearance-policy?project=${encodeURIComponent(project)}`, { headers, signal: AbortSignal.timeout(POLICY_TIMEOUT_MS) });
  } catch {
    // Last seen not enabled: still OpenCadre-free here while the hub is down, so nothing is held or blocked.
    if (hub.source === "device" && readCache()[deviceCacheKey]?.notEnabled) passThrough();
    return cached();
  }
  // Any HTTP answer at all: from here on a failure is the hub's (or this request's), not a transport failure (F7 / Q1f).
  hubAnswered = true;
  // The workspace hasn't enabled this project: behave exactly as if OpenCadre weren't configured. Never block, never
  // print, whatever the local config says (remembered, so a hub outage later doesn't change that).
  if (res.status === 403 && hub.source === "device") {
    const said = await res.clone().json().catch(() => ({}));
    if (isProjectNotEnabled(res.status, said)) {
      try {
        mkdirSync(join(cacheFile, ".."), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ ...readCache(), [deviceCacheKey]: { notEnabled: true, at: new Date().toISOString() } }, null, 2));
      } catch { /* best effort */ }
      passThrough();
    }
  }
  if (hub.source === "device" && readCache()[deviceCacheKey]) {
    // Any other answer means the hub checked this project and let it through: it's enabled now.
    try {
      const { [deviceCacheKey]: _dropped, ...rest } = readCache();
      writeFileSync(cacheFile, JSON.stringify(rest, null, 2));
    } catch { /* best effort */ }
  }
  // A rejected key won't heal on retry, and rotating a key is how an operator cuts an agent off:
  // fail closed and say why, rather than quietly falling back to the cache.
  // Resolve-only (Claude Code and Codex hooks; OpenCode creates its chat session above): this chat has no session on the hub yet, so there is no identity to act
  // as. That's "no hub for this chat", like an unconfigured one, not a rejected key: the last known policy still applies,
  // and an ask or strict clearance below fails closed under onHubUnreachable.
  if (res.status === 401 && hub.source === "device") {
    const said = await res.clone().json().catch(() => ({}));
    if (said?.error === NO_SESSION_ERROR) {
      if (OPEN_SEAT_WHEN_RISKY && !seatOpened && plan("ask", HUB_KNOBS).action !== "pass") {
        seatOpened = true;
        const opened = resolveHub({ client: gateClient, cwd, sessionId: gateSessionId, create: true });
        if (opened.key && opened.headers) {
          delete headers[RESOLVE_ONLY_HEADER];
          Object.assign(headers, opened.headers);
          return hubMode();
        }
      }
      noSession = true;
      return cached();
    }
  }
  if (REPORT && !res.ok) return cached();
  // Billing lapsed: pass the command through, exactly as if OpenCadre were not configured (#416 §8
  // item 6). This has to come BEFORE the cached-policy fallback below, because that fallback treats a
  // non-401/403 failure as "the hub is unreachable" and applies the last known mode -- so on a machine
  // whose cached mode is `strict`, a lapsed subscription would deny the user's own command. The bill
  // is not an outage, the hub answered, and the user cannot fix an invoice from inside their editor.
  if (res.status === 402) {
    const said = await res.clone().json().catch(() => ({}));
    if (isBillingReadOnly(res.status, said)) passThrough();
  }
  if (res.status === 401 || res.status === 403) {
    emit("deny", `OpenCadre approval gate: the hub rejected this agent's key (HTTP ${res.status}), so this command is blocked (fail closed). Reconnect with \`opencadre connect\`, or ask the user before trying another way.`);
  }
  if (!res.ok) return cached();
  let mode;
  try {
    mode = (await res.json())?.policy?.mode;
  } catch {
    mode = undefined;
  }
  if (!MODES.includes(mode)) {
    if (REPORT) return cached();
    emit("deny", "OpenCadre approval gate: the workspace clearance policy could not be read (malformed response), so this command is blocked (fail closed). Ask the user before trying another way.");
  }
  try {
    mkdirSync(join(cacheFile, ".."), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ ...readCache(), [cacheKey]: { mode, at: new Date().toISOString() } }, null, 2));
  } catch {
    // The cache only matters while the hub is unreachable; a read-only home still gets the fresh mode.
  }
  policyRead = true;
  return mode;
}

const HUB_KNOBS = {
  rules: DEFAULT_RULES, allow: [], useDefaultAllowlist: true,
  protectedBranches: DEFAULTS.protectedBranches, onTimeout: "deny", onHubUnreachable: "deny",
};
// Cursor 3.22.7 strips the host from a UNC workspace in hook payloads: opening
// \\localhost\C$\work sends /C$/work. The hook runs from ~/.cursor and receives no
// other trusted full workspace path on beforeShellExecution. Treating /C$/work as
// a local project lets the hub say "not enabled" and silently pass a delete.
// A mapped drive reports /X:/work, which hookCwd can resolve to the real project.
const cursorRoot = Array.isArray(input?.workspace_roots)
  ? input.workspace_roots.find((r) => typeof r === "string" && r) : undefined;
if (gateClient === "cursor" && process.platform === "win32" && openCadreHere && typeof cursorRoot === "string"
  && cursorRoot.startsWith("/") && !/^\/[A-Za-z]:[\\/]/.test(cursorRoot)
  && (plan("ask", HUB_KNOBS).action !== "pass" || plan("ask", { ...cfg, rules: localRules }).action !== "pass")) {
  emit("deny", "OpenCadre cannot identify this project on a network share from Cursor's hook path, so this risky command is blocked. Open the project from a mapped drive letter and try again.");
}
// Antigravity's CLI names no workspace to its hooks, and runs them in ~/.gemini/config. When the conversation's folder
// cannot be found either (hookCwd: the agy process's own working directory, which Windows does not give), the project
// and its policy are unknown, and reading them from ~/.gemini/config would let every command
// through. Where OpenCadre is set up for this chat, a command the hub's default rules would hold is blocked instead,
// with what fixes it (reviews of 601e5ff B1 and d790104 S1). With nothing set up there is no OpenCadre to answer to.
const antigravityPayload = typeof input?.conversationId === "string" && Array.isArray(input?.workspacePaths);
if (antigravityPayload && openCadreHere && !input.workspacePaths.some((p) => typeof p === "string" && p)
  && !antigravityWorkspace() && plan("ask", HUB_KNOBS).action !== "pass") {
  // On Windows the process tree gives no working directory, so the folder must come from agy itself: --add-dir.
  emit("deny", `OpenCadre could not tell which project this Antigravity conversation is in, so this command was blocked. ${process.platform === "win32" ? "Start agy with the project's own folder as a full path: `agy --add-dir \"C:\\path\\to\\project\"` (in PowerShell, `agy --add-dir (Get-Location)` from that folder; a relative `.` is not passed on)" : "Start agy from the project's folder"}, then try again.`);
}
// Not on this computer's enabled-project list (scripts/opencadre-config.mjs folderAccess): behave exactly as if OpenCadre
// weren't installed, whatever the local config says -- the same answer the hub's project_not_enabled gets below, reached
// without a request, so the hub never learns this folder was open.
if (hub.notEnabled) passThrough();
const decision = stricter(plan(localMode, { ...cfg, rules: localRules }), plan(await hubMode(), HUB_KNOBS));
// Past every "OpenCadre is not here" exit (a folder off the enabled list, a project the workspace has not enabled, a
// lapsed bill), and a risky rule matched: now a config warning is worth a line. Printed any earlier, it would break the
// quiet an unopted project is promised.
if (process.env.OPENCADRE_GATE_WARN !== "silent") {
  for (const warning of cfg.warnings) {
    try {
      writeSync(2, `${warning}\n`);
    } catch { /* stderr gone */ }
  }
}
if (decision.action === "pass") passThrough();
// Notify never blocks: the gate has decided this command runs, and a crash while recording it keeps that decision.
if (decision.action === "notify") failure.passes = true;
if (decision.action === "ask") {
  cfg.onTimeout = decision.onTimeout;
  cfg.onHubUnreachable = decision.onHubUnreachable;
}
const matched = decision.matched;
const category = matched.category || "custom";
// Rules above matched the command as typed; only the text that leaves this machine is masked (keys, tokens, passwords),
// and it is masked before it is cut to length so a secret is never sent half-masked. The approval request, the notify
// record and the post-execution report all send body.action.
// cfg.approver may name more than one reviewer ("Claude-Supervisor,Claude-LeadImplementer") -- e.g.
// for git-commit/git-push categories that want both aware. A named approver is only notified: a PERSON
// decides the request in OpenCadre (person approvals, migration 53), so the first name is the formal
// approval-record target and any others just get an extra heads-up message below.
const approvers = String(cfg.approver || "").split(",").map((s) => s.trim()).filter(Boolean);
const body = {
  action: maskSecrets(command).slice(0, 500),
  details: maskSecrets(`${GATE_CLIENT_LABELS[gateClient] ?? "An agent"} wants to run this shell command${cwd ? ` in ${cwd}` : ""} (rule: ${category}).`),
  risk: matched.risk || "high",
  category,
  approver: approvers[0] || undefined,
};

async function notifyExtraApprovers(threadHint) {
  if (approvers.length <= 1 || !base || !key || noSession) return;
  for (const name of approvers.slice(1)) {
    await fetch(`${base}/v1/messages`, {
      method: "POST", headers, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        toAgent: name, priority: "medium",
        body: `${body.details} ${approvers[0]} is the approver of record${threadHint ? ` (thread ${threadHint})` : ""}; flagging for your awareness too.`,
      }),
    }).catch(() => {});
  }
}

const reportExecuted = (required) => (base && key && !noSession
  ? fetch(`${base}/v1/clearances/executed`, {
    method: "POST", headers, body: JSON.stringify({ action: body.action, required, category, risk: body.risk, approver: body.approver }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
  : undefined);

// --- Policy passes (F7 / board Q1f; Codex ruling corrections 1, 2 and 5) --------------------------------------------
// A fallback "allow" (onTimeout / onHubUnreachable) never approves anything: the gate says NO OPINION and the command
// goes back to the tool's own permission settings. That is recorded as what it is, a POLICY PASS: `clearance.policy_pass`
// on the hub (POST /v1/clearances/policy-pass), with the reason. Never /v1/clearances/executed: the tool may still deny
// the command, die first, or never run it, and execution is only ever claimed by a post-tool observation (--report).
// Never a person's decision either: the record says the command was handed back, and nothing about who decided next.
//
// When the hub cannot take the record now, it is queued on this machine, in ~/.opencadre/run/policy-pass (a folder the
// `opencadre-state` rule holds any command naming), one file per record:
//   - honest: the reason, the category, the MASKED command (as the approval request sends it), the tool, the project,
//     and the approval id when there is one. Never a key, never the unmasked command.
//   - deduplicated: each record has a random receipt id, sent every time it is retried; the hub records a receipt once.
//   - bound to the chat that made it: `identity` holds the hub, a one-way reference to the key and one to the tool
//     session, and a record is sent only by a later run of the SAME chat (same hub, key and session). A record whose
//     chat never comes back expires; no other chat can deliver it under its own identity.
//   - bounded: at most POLICY_PASS_MAX records (the oldest go first), each kept POLICY_PASS_RETENTION_MS, dropped after
//     POLICY_PASS_MAX_ATTEMPTS refusals by the hub; at most POLICY_PASS_PER_RUN are sent per run, each with a short
//     timeout, and a network failure stops the run's sending.
const POLICY_PASS_DIR = join(process.env.OPENCADRE_HOOK_HOME || homedir(), ".opencadre", "run", "policy-pass");
const POLICY_PASS_MAX = 100;
const POLICY_PASS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const POLICY_PASS_MAX_ATTEMPTS = 5;
const POLICY_PASS_PER_RUN = 5;
const POLICY_PASS_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const oneWay = (label, value) => createHash("sha256").update(`opencadre-policy-pass\n${label}\n${value}`).digest("hex").slice(0, 32);
/** The chat's own session id, or null when the tool gave none (then there is no chat to bind a queued record to). */
const policyPassSession = () => {
  const id = hookSessionId(input, gateClient);
  return typeof id === "string" && id.trim() ? id : null;
};
/** Who this run acts as, and in which project, without the key, the session id or the folder themselves; null with no
 * hub and key (nothing to report to) or with no session id (no chat to bind a record to: Codex review of #680, 1). The
 * project is part of it (review 2): the same chat moved to another project never delivers the first project's records. */
const policyPassIdentity = () => {
  const session = policyPassSession();
  if (!base || !key || !session) return null;
  return {
    hub: base, keyRef: oneWay("key", key), sessionRef: oneWay("session", `${gateClient}\n${session}`),
    projectRef: oneWay("project", projectOf() || `local:${resolvePath(cwd)}`),
  };
};
const sameIdentity = (x, y) => Boolean(x && y) && ["hub", "keyRef", "sessionRef", "projectRef"].every((k) => typeof x[k] === "string" && x[k] === y[k]);

function readPolicyPasses() {
  let names = [];
  try {
    names = readdirSync(POLICY_PASS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!POLICY_PASS_FILE.test(name)) continue;
    const file = join(POLICY_PASS_DIR, name);
    let rec = null;
    try {
      rec = JSON.parse(readFileSync(file, "utf8"));
    } catch { /* unreadable: dropped below */ }
    const at = Date.parse(rec?.occurredAt);
    const valid = rec?.v === 1 && `${rec.receiptId}.json` === name && Number.isFinite(at) && typeof rec.identity?.hub === "string";
    if (!valid || Date.now() - at > POLICY_PASS_RETENTION_MS || !(Number(rec.attempts ?? 0) < POLICY_PASS_MAX_ATTEMPTS)) {
      try {
        unlinkSync(file);
      } catch { /* already gone */ }
      continue;
    }
    out.push({ file, rec, at });
  }
  return out.sort((x, y) => x.at - y.at);
}

function queuePolicyPass(rec) {
  try {
    mkdirSync(POLICY_PASS_DIR, { recursive: true, mode: 0o700 });
    const queued = readPolicyPasses();
    for (const old of queued.slice(0, Math.max(0, queued.length - (POLICY_PASS_MAX - 1)))) {
      try {
        unlinkSync(old.file);
      } catch { /* already gone */ }
    }
    writeFileSync(join(POLICY_PASS_DIR, `${rec.receiptId}.json`), JSON.stringify(rec), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** "ok" (recorded, now or before), "refused" (the hub answered no: counted against the record), or "failed". */
async function sendPolicyPass(rec, delivery, timeoutMs) {
  try {
    const res = await fetch(`${base}/v1/clearances/policy-pass`, {
      method: "POST", headers, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        receiptId: rec.receiptId, reason: rec.reason, action: rec.action, category: rec.category, risk: rec.risk,
        client: rec.client, project: rec.project, occurredAt: rec.occurredAt, delivery,
        ...(rec.approvalId ? { approvalId: rec.approvalId } : {}),
      }),
    });
    typeof res.body?.cancel === "function" && res.body.cancel().catch(() => {});
    return res.ok ? "ok" : res.status < 500 ? "refused" : "failed";
  } catch {
    return "failed";
  }
}

/** Sends this chat's queued records, oldest first, once the hub has answered this run's policy read as this chat. */
async function flushPolicyPasses() {
  const me = policyPassIdentity();
  if (!me || !policyRead || noSession) return;
  const mine = readPolicyPasses().filter(({ rec }) => sameIdentity(rec.identity, me)).slice(0, POLICY_PASS_PER_RUN);
  for (const { file, rec } of mine) {
    const sent = await sendPolicyPass(rec, "queued", 3000);
    if (sent === "failed") break;
    try {
      if (sent === "ok") unlinkSync(file);
      else writeFileSync(file, JSON.stringify({ ...rec, attempts: Number(rec.attempts ?? 0) + 1 }), { mode: 0o600 });
    } catch { /* dropped at expiry */ }
  }
}

await flushPolicyPasses();

if (REPORT) {
  await reportExecuted(decision.action === "ask" ? "approval" : "record");
  passThrough();
}

if (decision.action === "notify") {
  if (base && key && !noSession) {
    await fetch(`${base}/v1/approvals`, {
      method: "POST", headers, body: JSON.stringify({ ...body, notifyOnly: true }), signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    await notifyExtraApprovers();
  }
  passThrough();
}

// ask / strict
const TOOL_LABEL = GATE_CLIENT_LABELS[gateClient] ?? "your tool";
/** A policy fallback of "allow": NO OPINION, recorded as a policy pass (see above), never an approval. `reason` is
 * "timeout" or "hub_unreachable". Only the live record needs the network; a queued one is a local write. */
async function handBack(reason, why, approvalId) {
  const knob = reason === "timeout" ? "onTimeout" : "onHubUnreachable";
  const identity = policyPassIdentity();
  let recorded = "not recorded: no OpenCadre hub or key is configured";
  if (base && key) {
    const rec = {
      v: 1, receiptId: randomUUID(), occurredAt: new Date().toISOString(), reason, category, risk: body.risk,
      action: body.action, client: gateClient, project: projectOf(), ...(approvalId ? { approvalId } : {}),
      identity, attempts: 0,
    };
    // Sent now, under this run's own identity, needs no binding. Kept for later, it must name its chat: with no session
    // id there is none, so it is NOT queued (a later run with no session id could not prove it is the same chat).
    const live = reason === "timeout" && !noSession && (await sendPolicyPass(rec, "live", 5000)) === "ok";
    recorded = live ? "recorded in OpenCadre as a policy pass"
      : !identity ? "not recorded: this chat has no session id, so the record cannot be kept for it"
        : queuePolicyPass(rec) ? "queued for OpenCadre as a policy pass" : "could not be recorded";
  }
  const said = `OpenCadre approval gate: ${why}; ${knob} is "allow", so this ${category} command goes back to ${TOOL_LABEL}'s own permission settings, with no OpenCadre approval (${recorded}).`;
  try {
    writeSync(2, `${said}\n`);
  } catch { /* stderr gone */ }
  // No provenance: every dialect prints this as no opinion (permissionOutput), never as an allow.
  emit("allow", said);
}
/** The hub could not be reached at all (no hub or key, or a connection that failed before the hub ever answered):
 * onHubUnreachable decides, and its "allow" is a policy pass. */
const transportFailure = async (why) => (cfg.onHubUnreachable === "allow"
  ? handBack("hub_unreachable", why)
  : emit("deny", `OpenCadre approval gate: ${why}, so this ${category} command is blocked (fail closed). Ask the user before trying another way.`));
/** The hub is reachable but this request cannot proceed (no session yet, the request refused, an unexpected error): an
 * ERROR, like a failed wait (F6). It fails closed whatever onHubUnreachable says. */
const reachableError = (why) => emit("deny", `OpenCadre approval gate: ${why}, so this ${category} command is blocked (fail closed). This is an error, not an unreachable hub, so onHubUnreachable does not apply. Ask the user before trying another way.`);
// Failures of the connection itself, before any HTTP answer: the only ones that make the hub "unreachable".
const TRANSPORT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
// fetch() rejects with TypeError "fetch failed" for every network error before a response (a refused connection, a DNS
// failure, a port fetch will not use), with the cause, when there is one, in `cause`.
const isTransportError = (err) => err?.name === "TimeoutError" || (err?.name === "TypeError" && err?.message === "fetch failed")
  || TRANSPORT_CODES.has(err?.cause?.code) || TRANSPORT_CODES.has(err?.code);

if (!base || !key) await transportFailure("no OpenCadre hub or key configured for this client");
if (noSession) reachableError("this chat has no OpenCadre session yet");

// A harness that runs the call once its hook times out caps the wait inside that timeout: a repository's
// approval-gate.json or OPENCADRE_APPROVAL_WAIT above it would turn every unanswered approval into "runs" (reviews of
// 3f5e2a1 and 7ffc12c; measured for Gemini and Qwen too). waitCapFor says the cap; only an in-process plugin's gate
// (Kilo, Amp), which nothing kills, keeps its configured wait.
const WAIT_CAP = Math.min(waitCapFor(gateClient), hookHost(input) ? waitCapFor(hookHost(input)) : Infinity);
const waitSeconds = Math.min(Number.isFinite(cfg.waitSeconds) && cfg.waitSeconds > 0 ? cfg.waitSeconds : 540, WAIT_CAP);
const WAIT_RETRY_MS = Number(process.env.OPENCADRE_WAIT_RETRY_MS) > 0 ? Number(process.env.OPENCADRE_WAIT_RETRY_MS) : 1000;
const deadline = Date.now() + waitSeconds * 1000;
// A configuration fault must not read as a dead hub. The hub resolves `approver` to ONE agent and
// rejects the whole request at creation when it cannot -- so no decision window opens and an approval
// a human granted has no effect. A stale name in a config file has therefore silently disabled every
// gated action fleet-wide. #277 surfaced the reason; this keeps it from blocking:
// on a rejected creation, retry once WITHOUT the approver, which the hub accepts. That only ever
// changes WHO is asked, never WHETHER the action is gated, so it cannot allow a command.
const postApproval = (payload) => fetch(`${base}/v1/approvals`, {
  method: "POST", headers, body: JSON.stringify({ ...payload, expiresInSeconds: waitSeconds }), signal: AbortSignal.timeout(15000),
}).then((res) => {
  hubAnswered = true;
  return res;
});
const hubReason = (res) => res.json().then((b) => (typeof b?.error === "string" ? `: ${b.error.slice(0, 200)}` : ""), () => "");

try {
  let created = await postApproval(body);
  // The policy read is a GET and remains 200 after billing lapses; the approval CREATE is a
  // write and returns 402. Treat that response as no OpenCadre gate, before retrying approvers
  // or applying the unreachable fallback. A cached strict mode must not trap the editor.
  const billingQuiet = async (res) => res?.status === 402
    && isBillingReadOnly(res.status, await res.clone().json().catch(() => ({})));
  if (await billingQuiet(created)) passThrough();
  // Report the fallback to the agent on every path that follows, so a dead name is fixed rather
  // than absorbed: a silent fallback would recreate the original bug in a new form -- the fleet
  // keeps working while every request quietly goes somewhere other than the named reviewer.
  let approverWarning = "";
  if (!created.ok && body.approver) {
    const reason = await hubReason(created);
    const retry = await postApproval({ ...body, approver: undefined });
    if (await billingQuiet(retry)) passThrough();
    if (retry.ok) {
      created = retry;
      approverWarning = `OpenCadre approval gate: the configured approver "${body.approver}" does not exist, so this request went to the workspace's operators instead. Fix the approver in your approval-gate config.`;
      if (process.env.OPENCADRE_GATE_WARN === "silent") approverWarning = "";
      console.error(approverWarning);
    } else {
      // The retry failed too, so the request itself is bad, not the approver: fail closed as before.
      typeof retry.body?.cancel === "function" && retry.body.cancel().catch(() => {});
      reachableError(`the approval request was refused (HTTP ${retry.status}${await hubReason(retry) || reason})`);
    }
  }
  if (!created.ok) {
    // Say WHY. A bare "HTTP 400" hid a stale approver name in a committed config for a whole day: the hub
    // rejects the request at creation (no decision window ever opens), and its reason is in the body.
    const reason = await hubReason(created);
    reachableError(`the approval request was refused (HTTP ${created.status}${reason})`);
  }
  let { approval } = await created.json();
  await notifyExtraApprovers(approval.id);

  // A failed wait is an ERROR, never a timeout (Codex ruling F6): it FAILS CLOSED whatever onTimeout says, and says it
  // failed rather than that nobody answered. onTimeout governs only a genuine timeout: the hub answered, and kept
  // answering "still pending", until the deadline. A 4xx (revoked key, unknown request) or an answer that is not an
  // approval ends the wait at once. A hub restart (a deploy) drops the wait or answers 502/503 for a few seconds; that
  // isn't a decision, so those (and 429) are retried until the deadline -- but if the LAST attempt before the deadline
  // still failed, nobody can say the approval went unanswered, so that too is an error, not a timeout.
  const WAIT_STATUSES = ["pending", "approved", "denied", "expired", "withdrawn"];
  let waitError = null;
  const waitFailed = (why) => {
    const reason = `${approverWarning ? `${approverWarning} ` : ""}OpenCadre approval gate: waiting for the decision on this ${category} command failed (${why}), so it is blocked (fail closed). This is an error, not a timeout. Do not retry this or a workaround without asking the user.`;
    try {
      writeSync(2, `OpenCadre approval gate: waiting for approval ${approval?.id ?? "?"} failed (${why}); blocked.\n`);
    } catch { /* stderr gone: still block */ }
    emit("deny", reason);
  };
  while (approval.status === "pending" && Date.now() < deadline) {
    const slice = Math.max(1, Math.min(55, Math.ceil((deadline - Date.now()) / 1000)));
    let res;
    const started = Date.now();
    let networkError = "";
    try {
      res = await fetch(`${base}/v1/approvals/${approval.id}/wait?timeoutSeconds=${slice}`, { headers, signal: AbortSignal.timeout(Math.min(slice + 15, Math.ceil((deadline - started) / 1000) + 5) * 1000) });
    } catch (err) {
      res = null;
      networkError = String(err?.cause?.code || err?.name || err?.message || "request failed");
    }
    // If the bill lapses during a pending approval, OpenCadre releases this command as a plain
    // editor command. The product's lapsed-bill rule ends our hold immediately, not only on the
    // next command. The hub will no longer accept an approval decision for this wait.
    if (await billingQuiet(res)) passThrough();
    if (res && res.ok) {
      let said;
      try {
        said = await res.json();
      } catch {
        said = undefined;
      }
      const next = said?.approval;
      if (!next || typeof next !== "object" || !WAIT_STATUSES.includes(next.status)) waitFailed(`HTTP ${res.status}, malformed response`);
      approval = next;
      waitError = null;
      // A draining hub answers "still pending" at once instead of holding the wait: pause rather than spin.
      if (approval.status === "pending" && Date.now() - started < WAIT_RETRY_MS) {
        await new Promise((r) => setTimeout(r, Math.min(WAIT_RETRY_MS, Math.max(0, deadline - Date.now()))));
      }
      continue;
    }
    if (res && res.status < 500 && res.status !== 429) waitFailed(`HTTP ${res.status}${await hubReason(res)}`);
    typeof res?.body?.cancel === "function" && res.body.cancel().catch(() => {});
    waitError = res ? `HTTP ${res.status}` : `network error: ${networkError}`;
    await new Promise((r) => setTimeout(r, Math.min(WAIT_RETRY_MS, Math.max(0, deadline - Date.now()))));
  }
  if (waitError && approval.status === "pending") waitFailed(`${waitError}, still failing when the ${waitSeconds}s wait ran out`);

  // A clearance passes only on a PERSON's decision: the hub's row names them (`decided_by_person_id`, migration 53; a
  // grant's auto-approval carries its person too). An "approved" row with no person -- decided by an agent before
  // migration 53, or sent by a hub older than this hook (a rollback, a mixed-version fleet) -- is not a clearance: it
  // FAILS CLOSED on every client, never falls through to onTimeout, and is never called "approved".
  const byPerson = Boolean(approval.decided_by_person_id);
  const decidedBy = approval.decided_by_person_name || approval.decided_by_agent_name;
  if (approval.status === "approved" && !byPerson) {
    emit("deny", `${approverWarning ? `${approverWarning} ` : ""}OpenCadre approval gate: this command is blocked because the decision on it did not come from a person, or your OpenCadre hub is older than this hook. Update or reconnect OpenCadre, then have a person approve it in OpenCadre on their phone or computer. Do not retry this or a workaround without asking the user.`);
  }
  // Correction 4: a person's standing grant is person-issued but is not a decision on THIS command, and says so.
  if (approval.status === "approved" && approval.decided_via === "grant") {
    emit("allow", `${approverWarning ? `${approverWarning} ` : ""}Allowed in OpenCadre by ${decidedBy}'s standing "${category}" grant (not a new decision on this command)`, { provenance: "grant" });
  }
  if (approval.status === "approved") {
    emit("allow", `${approverWarning ? `${approverWarning} ` : ""}Approved in OpenCadre by ${decidedBy}${approval.decision_note ? `: ${approval.decision_note}` : ""}`, { provenance: "person" });
  }
  if (approval.status === "denied") {
    emit("deny", `${approverWarning ? `${approverWarning} ` : ""}OpenCadre approval gate: denied by ${decidedBy}${approval.decision_note ? `: ${approval.decision_note}` : ""}. Do not retry this or a workaround without asking the user.`);
  }
  // The agent that asked took the request back (POST /v1/approvals/:id/withdraw). Final, and nobody decided it: a deny
  // whatever onTimeout says, never the timeout hand-back below, which would pass the command to the tool's own settings.
  if (approval.status === "withdrawn") {
    emit("deny", `${approverWarning ? `${approverWarning} ` : ""}OpenCadre approval gate: withdrawn by the agent that asked${approval.decision_note ? `: ${approval.decision_note}` : ""}. Do not retry this or a workaround without asking the user.`);
  }
  // F7 / Q1f: nobody decided, so this is not an allow. The command goes back to the tool's own permission settings, and
  // the hub records a policy pass (not an execution: whether it runs is for a post-tool observation to say).
  if (cfg.onTimeout === "allow") await handBack("timeout", `${approverWarning ? `${approverWarning} ` : ""}no decision in ${waitSeconds}s`, approval.id);
  emit("deny", `${approverWarning ? `${approverWarning} ` : ""}OpenCadre approval gate: no approval received in ${waitSeconds}s (${approval.status}). Do not retry this or a workaround without asking the user.`);
} catch (err) {
  // A connection that failed before the hub ever answered is an unreachable hub; anything else is an error (F7 / Q1f).
  if (!hubAnswered && isTransportError(err)) await transportFailure(`hub unreachable (${err.message})`);
  reachableError(`an unexpected error (${err?.message ?? err})`);
}
