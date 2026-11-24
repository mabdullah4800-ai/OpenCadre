#!/usr/bin/env node
// Guard logic and execution flow for deepseek-agent-bridge.mjs's local shell tool. Separated out so
// it's actually unit- and integration-testable: the bridge script itself runs its whole message loop
// at import time (no `if (import.meta.url === ...)` entrypoint guard), so importing it for a test
// would start a real bridge that also needs a live TheHive API key. This module has no such problem:
// the execution functions take a `callHubTool` callback instead of reaching for hub state directly,
// so a test can wire them to a real in-memory hub (or a fake) without any of that.
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Splits a comma-separated allowlist into trimmed, non-empty entries. Deliberately does NOT resolve
 * or check existence here anymore -- it used to (dropping a path that didn't exist yet on disk), but
 * that ran ONCE at bridge startup (deepseek-agent-bridge.mjs computes SHELL_ALLOWED_PATHS as a
 * module-level const), so a worktree created AFTER the bridge process launched was permanently
 * locked out of that process's allowlist for its entire lifetime, even after the directory existed --
 * confirmed live: two agents with the identical configured allowlist pattern got different
 * enforcement outcomes for the same path, purely because their bridge processes started at different
 * times relative to when that worktree was created. isAllowedCwd already re-resolves every entry
 * fresh on every single call (see below); the fix is to stop pre-filtering here and let that dynamic
 * check be the only source of truth, every time, so a directory that starts existing after the bridge
 * is already running becomes usable on the very next command, no restart needed. */
export function parseAllowedPaths(raw) {
  return (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** True only when cwd resolves (following symlinks) to one of the allowed directories, or a path
 * inside one of them. Never true when the allowlist is empty -- shell execution is opt-in. Resolves
 * cwd AND every allowedPaths entry fresh on every call -- this is the only existence/symlink check in
 * the whole path (parseAllowedPaths above no longer does any), so a directory that doesn't exist yet,
 * or one that started existing since the process launched, or a symlink (e.g. macOS's /var, a symlink
 * to /private/var), are all handled correctly and consistently on every single check, not just at
 * startup. */
export function isAllowedCwd(cwd, allowedPaths) {
  if (typeof cwd !== "string" || !cwd || allowedPaths.length === 0) return false;
  let real;
  try {
    real = realpathSync(cwd);
  } catch {
    return false;
  }
  return allowedPaths.some((entry) => {
    let base;
    try {
      base = realpathSync(entry);
    } catch {
      return false;
    }
    // Containment must be boundary-aware on EVERY platform. Comparing against a hardcoded
    // forward slash (the previous form) can only ever match on POSIX: win32 realpathSync returns
    // backslash-separated paths, so the subdirectory branch was dead there and only the
    // exact-directory branch ever matched. Normalize BOTH sides to the platform separator, and
    // keep the separator in the bound so a similarly-prefixed sibling ("<base>-evil") is still
    // rejected -- the prefix test without the boundary is the bug this guard exists to prevent.
    const sep = path.sep;
    const normReal = real.endsWith(sep) ? real.slice(0, -1) : real;
    const normBase = base.endsWith(sep) ? base.slice(0, -1) : base;
    return normReal === normBase || normReal.startsWith(`${normBase}${sep}`);
  });
}

/** A hub approval-tool result, normalized: the text a model reads, and the STRUCTURED approval record the hub attaches
 * (src/mcp.ts approvalResult: `structuredContent.approval`). `callHubTool` may return a plain string (text only) or
 * `{ text, structured }`. A string, or a result with no record, is what a hub older than person approvals sends. */
export function hubResult(result) {
  if (result === null || result === undefined || typeof result === "string") return { text: String(result ?? ""), approval: null };
  const approval = result.structured?.approval;
  return { text: String(result.text ?? ""), approval: approval && typeof approval === "object" ? approval : null };
}

/** Cleared to run: the hub's STRUCTURED record says approved AND names the person who decided it (a person's grant
 * auto-approval records its person too). Never read from display text: an older hub's "[APPROVED]" may be an agent's
 * decision, and a harmless probe on one actually ran with no person (Codex, #653). No record, no person: not cleared. */
export function isApproved(result) {
  const { approval } = hubResult(result);
  return approval?.status === "approved" && typeof approval.decided_by_person_id === "string" && approval.decided_by_person_id.length > 0;
}

/** Still waiting. The record when there is one; the text otherwise (only ever keeps a wait going, never runs anything). */
export function isPending(result) {
  const { text, approval } = hubResult(result);
  return approval ? approval.status === "pending" : /^\[PENDING\]/.test(text);
}

/** The approval id: the record's, else the one formatApproval's text embeds ("...id <uuid>)..."). An id is not identity. */
export function extractApprovalId(result) {
  const { text, approval } = hubResult(result);
  if (typeof approval?.id === "string") return approval.id;
  return text.match(/id ([0-9a-f-]{36})/)?.[1] ?? null;
}

const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/** The POSIX shell to run `command` under. On POSIX it is /bin/sh, always.
 *
 * On Windows there is no /bin/sh: the literal string resolves against the Windows filesystem, where
 * there is no \bin at the drive root, so execFile failed with ENOENT for EVERY command and the whole
 * run_shell tool was dead on this platform. Node performs no MSYS translation (Git Bash's shell does,
 * which is why `which sh` succeeds there and misleads). Measured: execFile("/bin/sh", …) -> ENOENT
 * while `bash`, `sh` and `C:/Program Files/Git/bin/sh.exe` all succeed, so no shell was ever missing.
 *
 * We deliberately resolve a real POSIX shell rather than switch to cmd.exe. classifyCommand's whole
 * verb allowlist (cat/grep/sed -n/find/pytest/git …), the redirection in the tests, and documented
 * uses like `env X=1 echo` are written against POSIX semantics; cmd.exe would silently change what
 * every allowlisted command means. Worse, its behaviour here is launch-dependent: measured on
 * Windows 11, `cmd.exe /c "env X=1 echo hi"` prints the output with exit 0 when launched from Git
 * Bash (Git's usr\bin is on PATH) and fails with exit 1 from PowerShell. A command that means
 * different things depending on how the hub was started is worse than one that is plainly broken.
 *
 * Resolved fresh on every call, not cached at module load -- same reasoning as isAllowedCwd: a
 * process-start-time decision is exactly the bug 369d9f7 had to fix for the allowlist. Resolution is
 * a few stat calls, negligible against spawning a shell. */
function resolveShell() {
  if (process.platform !== "win32") return { bin: "/bin/sh", why: null };
  const candidates = [
    process.env.OPENCADRE_SHELL_BIN, // explicit override wins when set and real
    process.env.SHELL,
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/sh.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  ].filter(Boolean);
  const found = candidates.find((p) => {
    // SHELL can name PowerShell in a Windows-hosted Node process. An existing executable is
    // insufficient: the commands and approval classifier require POSIX -c semantics.
    if (!/^(?:sh|bash|dash|zsh)(?:\.exe)?$/i.test(path.basename(p))) return false;
    try { return statSync(p).isFile(); } catch { return false; }
  });
  if (found) return { bin: found, why: null };
  // No POSIX shell found. Return a reason instead of a path: a tool that cannot run a shell should
  // say so in words the model can read, not hand back a bare ENOENT the model cannot act on.
  return { bin: null, why: "no POSIX shell found on this Windows host (checked OPENCADRE_SHELL_BIN, SHELL, and the standard Git for Windows install paths). run_shell needs sh or bash; install Git for Windows, or set OPENCADRE_SHELL_BIN to its sh.exe." };
}

/** Runs `command` in `cwd` via sh -c, capped by timeout and output size. Never throws --
 * timeouts and non-zero exits come back as text, same as any other tool result the model reads.
 *
 * Note on `pwd` on Windows: a Git-for-Windows shell prints the path through its own mount table, so
 * a cwd under %TEMP% comes back as `/tmp/<dir>` rather than the `C:\...` spelling Node handed it
 * (measured: the same bash.exe prints `C:/...` for a repo cwd and `/tmp/...` for a %TEMP% cwd).
 * That is the shell's mount, not a bug here, and it cannot be switched off by environment: MSYSTEM
 * is re-injected by the MSYS runtime even when deleted, and usr/bin/sh.exe prints an MSYS path
 * regardless. Callers must therefore treat a shell-printed path as the shell's own spelling of cwd
 * -- compare filesystem identity, not the string. */
export function execCommand(cwd, command, { timeoutMs = 120_000, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = {}) {
  const { bin, why } = resolveShell();
  if (!bin) return Promise.resolve(`Error: ${why}`);
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
        const out = combined.length > maxOutputChars ? `${combined.slice(0, maxOutputChars)}\n…(truncated)` : combined;
        if (err?.killed) return resolve(`Command timed out after ${timeoutMs}ms.\n${out}`);
        if (err) return resolve(`Exit code ${err.code ?? "?"}.\n${out}`);
        resolve(out || "(no output)");
      },
    );
  });
}

/** Splits a possibly-comma-separated approver config ("Claude-Supervisor,Claude-LeadImplementer")
 * into a single formal-approver name (request_approval's `approver` field takes exactly one agent
 * name -- passing the raw compound string makes resolveAgent fail to find anyone) plus any extra
 * names to notify separately. Mirrors examples/hooks/opencadre-approval-gate.mjs's own handling of
 * the same config shape. */
export function splitApprovers(raw) {
  const names = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { primary: names[0], extras: names.slice(1) };
}

// Leading-word allowlist for a read-only classification. Deliberately small: every entry here must
// be unable to write, delete, or execute arbitrary code by itself. Notably excluded even though
// real audits used them: python3/node/ruby -c or -e (Turing-complete, can do anything the shell
// can); sed without confirming -n only; any find without confirming no -delete/-exec.
const READ_ONLY_VERBS = new Set(["cat", "ls", "pwd", "echo", "printf", "head", "tail", "wc", "true", "grep", "git", "find", "sed", "pytest"]);
// Git subcommands that only read. Anything else (commit, push, reset, checkout, merge, rebase,
// clean, add, stash, tag -d, ...) falls through to "git-mutate", never "read-only".
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["log", "status", "diff", "show", "branch", "worktree", "rev-parse", "ls-files", "blame", "remote", "shortlog", "describe"]);
// Every other git subcommand this classifier recognizes as a mutation, for the "git-mutate"
// category (a mutation classifier can be permissive about what it flags -- an unrecognized git
// subcommand not in either list falls through to the catch-all "write" category regardless).
const GIT_MUTATE_SUBCOMMANDS = new Set(["commit", "push", "reset", "checkout", "merge", "rebase", "clean", "add", "stash", "tag", "cherry-pick", "revert", "reflog", "gc", "filter-branch", "filter-repo"]);
// Any occurrence of these anywhere in the command marks it not-read-only, regardless of which verb
// leads: command substitution and background execution can smuggle a write through a "safe" verb
// (e.g. `echo $(rm -rf /)`), and these tokens are the general escape hatches for that.
const UNSAFE_ANYWHERE = [">", "<", "`", "$(", "sudo ", "curl ", "wget ", "ssh ", "scp ", "docker ", "kubectl ", "eval ", "exec ", "npm publish", "npm run", " -i ", "--in-place"];
// A single "&" (background execution) is unsafe; "&&" (top-level AND, handled by splitTopLevel) is
// not -- strip every "&&" pair first so a plain substring scan for "&" doesn't misfire on a chain.
const hasLoneAmpersand = (command) => command.replace(/&&/g, "").includes("&");

/** Splits a command line on top-level shell control operators (&&, ||, ;, |), NOT inside quotes.
 * Approximate on purpose: this is a heuristic classifier that only ever widens a command's chance
 * of needing a fresh individual approval, never the reverse -- getting a split wrong just means a
 * safe command doesn't get the fast path, not that an unsafe one does. */
function splitTopLevel(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && command[i + 1] === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === ";" || ch === "|") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Conservative, fail-closed three-way classification of a shell command:
 * - "read-only": auto-approved with no human round-trip at all (see runShellTool below). Restricted
 *   to a small verb allowlist that structurally cannot write, delete, or run arbitrary code -- with
 *   one deliberate exception: "pytest" is allowed through because a read-only-intent test run was
 *   an explicitly requested case, even though a test suite can technically have side effects (write
 *   fixtures, touch files). That's a real, accepted risk trade-off, not an oversight -- if this
 *   needs tightening later, drop "pytest" from READ_ONLY_VERBS.
 * - "git-mutate": a recognized git-history-changing subcommand (commit, push, reset, ...). Its own
 *   category so an operator can grant a time-boxed trust window on git mutations specifically,
 *   without that trust extending to arbitrary shell writes or vice versa.
 * - "write": the catch-all for everything else (rm, curl, python3 -c, an unrecognized git
 *   subcommand, anything with command substitution or a redirect). Always needs a fresh individual
 *   decision unless an operator has separately granted this category.
 * This is a heuristic over a real shell grammar, not a parser -- when genuinely uncertain, it picks
 * the more restrictive category. Never treat it as the security boundary by itself: for "write" and
 * "git-mutate", execCommand is only ever reached after a real approval decision; for "read-only",
 * the verb allowlist above IS the boundary, so keep it narrow. */
export function classifyCommand(command) {
  if (typeof command !== "string" || !command.trim()) return "write";
  const lower = command.toLowerCase();
  if (UNSAFE_ANYWHERE.some((tok) => lower.includes(tok)) || hasLoneAmpersand(command)) return "write";
  const segments = splitTopLevel(command);
  if (segments.length === 0) return "write";

  let sawGitMutate = false;
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/);
    const verb = words[0];
    if (verb === "git") {
      const sub = words[1];
      if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) continue;
      if (GIT_MUTATE_SUBCOMMANDS.has(sub)) { sawGitMutate = true; continue; }
      return "write"; // unrecognized git subcommand: don't guess, treat as a plain write
    }
    if (!READ_ONLY_VERBS.has(verb)) return "write";
    if (verb === "find" && (words.includes("-delete") || words.includes("-exec") || words.includes("-execdir"))) return "write";
    if (verb === "sed" && !words.includes("-n")) return "write";
  }
  return sawGitMutate ? "git-mutate" : "read-only";
}

/** Back-compat helper some callers may prefer over classifyCommand === "read-only". */
export const isReadOnlyCommand = (command) => classifyCommand(command) === "read-only";

const CATEGORY_FOR_TIER = { "read-only": "deepseek-shell-exec-readonly", "git-mutate": "deepseek-shell-exec-git-mutate", write: "deepseek-shell-exec-write" };

/** Requests approval via callHubTool("request_approval", ...), then keeps polling
 * callHubTool("wait_for_approval", ...) in slices up to totalWaitMs total -- the person deciding
 * taking a while shouldn't turn into an automatic deny. A PERSON decides (migration 53): the named
 * approver is notified as approver of record, but its own decide_approval call is refused, so it
 * cannot unblock the command. callHubTool is injected so a test
 * can point this at a real in-memory hub instead of a live one. `command` (optional) is classified
 * by classifyCommand to pick the approval category, so an operator can grant a time-boxed trust
 * window on write or git-mutate commands separately (a person's "approve for N minutes"), without
 * either bucket's grant extending to the other. Read-only commands never reach this function at all
 * (see runShellTool) -- they're auto-approved before any request_approval call is made. */
export async function awaitApproval(callHubTool, action, details, { approver, totalWaitMs = 15 * 60_000, command } = {}) {
  const { primary, extras } = splitApprovers(approver);
  const category = command !== undefined ? CATEGORY_FOR_TIER[classifyCommand(command)] : "deepseek-shell-exec-write";
  const first = await callHubTool("request_approval", {
    action: action.slice(0, 500), details, risk: "medium", category,
    approver: primary, waitSeconds: 270, expiresInSeconds: Math.ceil(totalWaitMs / 1000) + 60,
  });
  for (const name of extras) {
    await callHubTool("send_message", {
      toAgent: name, priority: "low",
      body: `${details ?? action} -- ${primary} is the approver of record for this run_shell request; flagging for your awareness too.`,
    }).catch(() => {});
  }
  const approvalId = extractApprovalId(first);
  if (isApproved(first) || !approvalId) return first;
  const deadline = Date.now() + totalWaitMs;
  let latest = first;
  while (isPending(latest) && Date.now() < deadline) {
    const slice = Math.max(1, Math.min(270, Math.ceil((deadline - Date.now()) / 1000)));
    latest = await callHubTool("wait_for_approval", { approvalId, waitSeconds: slice });
  }
  return latest;
}

/** The hub's own text when it refuses to create a request because `approver` resolves to nobody. */
const APPROVER_REFUSAL_RE = /no agent found matching approver/i;

/** What the model reads when the command did not run. Adds the one thing the hub's refusal cannot know
 * -- which config value chose that approver -- and only when BOTH hold: no approval id came back (so
 * the request was never created and nothing is waiting for anyone to decide), and the refusal names an
 * approver. Both tests are one-directional on purpose: if either misses, this returns exactly the
 * string run_shell returned before, so a wrong guess costs a missing hint, never a changed outcome.
 *
 * That fail-safe direction is why matching the hub's prose is acceptable here, having been rejected in
 * docs/design/GATE-APPROVER-RESILIENCE.md §4: there it would have decided WHETHER an action runs; here
 * it only decides whether to add advice to a message about an action that did not run. The structural
 * half (no approval id) is the load-bearing one; the prose match only names the culprit. */
export function notExecutedReason(decision, { approver, approverSource } = {}) {
  const { text, approval } = hubResult(decision);
  // "Approved", but not by a person the hub can name: an agent's decision, or a hub older than person approvals. Never
  // echoed as approved.
  if (approval?.status === "approved" || /^\[APPROVED\]/.test(text)) {
    return "Not executed -- the hub did not report a person's approval for this command (an agent decided it, or the hub " +
      "is older than this bridge and cannot say who decided). Update or reconnect OpenCadre, then have a person approve " +
      "it in OpenCadre on their phone or computer.";
  }
  // The agent that asked took the request back: the same reason the approval gate gives (opencadre-approval-gate.mjs).
  // The text test only ever names a reason for a command that did not run; it never decides whether one runs.
  if (approval?.status === "withdrawn" || /^\[WITHDRAWN\]/.test(text)) return "Not executed -- withdrawn by the agent that asked.";
  const base = `Not executed -- ${text}`;
  if (extractApprovalId(decision)) return base;
  if (!APPROVER_REFUSAL_RE.test(text)) return base;
  const named = approverSource ? `"${approver}" (from ${approverSource})` : `"${approver}"`;
  return (
    `${base}\nrun_shell was blocked, not denied: the hub refused the request at creation, so no approval ` +
    `exists and no operator can decide it. The approver came from ${named}. ` +
    (approverSource ? `Set ${approverSource} to a live agent name in this workspace` : "Name a live agent in this workspace") +
    `, or leave it unset so the request goes to the workspace's operators instead.`
  );
}

/** The run_shell tool's full flow: validate args, check the path allowlist (no bypass -- this runs
 * regardless of classification), then either run immediately (read-only, per classifyCommand) or
 * require a human decision first (write / git-mutate -- no bypass there either: execCommand is only
 * ever reached after isApproved(decision) is true). A read-only run still gets a fire-and-forget,
 * non-blocking, low-priority audit-trail message to the approver -- visibility without the
 * round-trip; with no approver configured there is no named reviewer to send it to, so that branch
 * sends nothing, and the auto-approval itself is unchanged. Auto-approval is scoped as tightly as the
 * allowedPaths cwd check plus classifyCommand's narrow verb allowlist; anything that classifier can't
 * confidently place still asks a human.
 *
 * `approverSource` (optional) is the name of the config the approver came from, e.g.
 * "DEEPSEEK_SHELL_APPROVER", used only to make a refusal actionable; see notExecutedReason. */
export async function runShellTool(callHubTool, args, { allowedPaths, approver, timeoutMs, maxOutputChars, totalWaitMs, approverSource } = {}) {
  const { cwd, command } = args ?? {};
  if (typeof cwd !== "string" || typeof command !== "string" || !command.trim()) {
    return "Error: cwd and command are required.";
  }
  if (!isAllowedCwd(cwd, allowedPaths ?? [])) {
    return `Error: cwd "${cwd}" is not in the allowed directory list (${(allowedPaths ?? []).join(", ") || "none configured -- shell execution is disabled"}).`;
  }
  if (classifyCommand(command) === "read-only") {
    const { primary } = splitApprovers(approver);
    if (primary) {
      callHubTool("send_message", {
        toAgent: primary, priority: "low",
        body: `Auto-approved (read-only): run_shell: ${command} -- cwd: ${cwd}`,
      }).catch(() => {});
    }
    return execCommand(cwd, command, { timeoutMs, maxOutputChars });
  }
  let decision;
  try {
    decision = await awaitApproval(callHubTool, `run_shell: ${command}`, `cwd: ${cwd}`, { approver, totalWaitMs, command });
  } catch (err) {
    return `Error requesting approval: ${err.message}`;
  }
  if (!isApproved(decision)) {
    return notExecutedReason(decision, { approver, approverSource });
  }
  return execCommand(cwd, command, { timeoutMs, maxOutputChars });
}
