import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The one CODEX_HOME resolver (§9 item 7). The inbox skill is a Codex-SPECIFIC installation, so its
// path has to follow a relocated CODEX_HOME too — otherwise `connect` writes the skill under a
// directory Codex never reads and then reports it installed.
import { codexHome } from "./clients.mjs";
import { readText } from "./files.mjs";

/** Codex in the ChatGPT desktop app has no asyncRewake, so idle wake comes from a scheduled task in a
 * dedicated inbox chat whose prompt invokes the opencadre-inbox skill. Both texts live in cli/templates
 * (packed with the CLI) so they can be changed in one place. Neither ever carries the key. */

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));
// A checkout with autocrlf may hold CRLF; the installed files are always LF so re-runs compare equal.
const template = (name) => readFileSync(join(TEMPLATES, name), "utf8").replace(/\r\n/g, "\n");

export const SKILL_NAME = "opencadre-inbox";
// The ChatGPT desktop app indexes personal skills from ~/.codex/skills (the documented ~/.agents/skills
// is not picked up there: openai/codex#28505).
export const inboxSkillFile = (home, env = process.env) => join(codexHome(home, env), "skills", SKILL_NAME, "SKILL.md");
export const inboxSetupFile = (home) => join(home, ".opencadre", "codex-inbox-setup.txt");

/** Returns { file, before, after } for the skill, without writing. */
export function planInboxSkill({ home, agentName }) {
  const file = inboxSkillFile(home);
  return { file, before: readText(file), after: template("codex-inbox-skill.md").replaceAll("{{AGENT_NAME}}", agentName) };
}

/** Returns { file, before, after, message } for the paste-ready scheduled-task message. */
export function planInboxSetup({ home }) {
  const file = inboxSetupFile(home);
  const after = template("codex-inbox-setup.txt");
  return { file, before: readText(file), after, message: after.trim() };
}

/** Machine connect: the same skill and scheduled-task message, for a computer where every Codex chat is its own session.
 * The chat calls the opencadre-session tools; its identity comes from the proxy, so neither text names an agent. */
export function planSessionInboxSkill({ home }) {
  const file = inboxSkillFile(home);
  return { file, before: readText(file), after: template("codex-session-inbox-skill.md") };
}

export function planSessionInboxSetup({ home }) {
  const file = inboxSetupFile(home);
  const after = template("codex-session-inbox-setup.txt");
  return { file, before: readText(file), after, message: after.trim() };
}

/** The platform's "put this file on the clipboard" one-liner, or null where we cannot name one.
 *
 * #368 asked for the setup message to be copyable in ONE action. It was already written to a file
 * and the path already printed (since 918b19a), so the missing piece was never storage -- it was
 * that the user had to know how to get a file onto their clipboard. The other option the issue
 * offered, a `--print-task-message` subcommand, is worse: it adds CLI surface to do what a pipe
 * already does, and would re-read this same file to do it.
 *
 * `platform` is a parameter rather than a read of process.platform so every branch is testable on
 * one machine. A helper whose only interesting behaviour is per-platform, tested only on the
 * platform the suite happens to run on, is the shape of bug #305 -- a fixture that passed on
 * Windows and failed everywhere else.
 *
 * Linux returns null deliberately rather than guessing: the answer is wl-copy or xclip or xsel
 * depending on the session, and naming the wrong one is worse than naming none. The path is printed
 * either way, so nothing is lost by staying quiet.
 *
 * The path is QUOTED on both platforms. `file` is `join(home, ".opencadre", ...)`, so it carries
 * the user's home directory, and a home with a space in it -- `C:\\Users\\John Smith`, `/Users/john
 * smith` -- is common on Windows and not rare on macOS. Unquoted, both shells split at the space:
 * cmd's `type` reports "The system cannot find the file specified", and sh redirects from
 * `/Users/john` and passes the rest as an argument. Either way the clipboard stays empty while the
 * line claims to be the one-step copy, which is worse than the manual open-and-select-all this
 * replaces -- that at least works. Found in review of #411 (reviewer 1051), measured on both shells.
 */
export function copyToClipboardHint(file, platform = process.platform) {
  if (platform === "darwin") return `pbcopy < "${file}"`;
  if (platform === "win32") return `type "${file}" | clip`;
  return null;
}
