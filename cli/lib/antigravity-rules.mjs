import { join } from "node:path";
import { readText } from "./files.mjs";

/** Antigravity's global rules file: plain Markdown that every conversation reads. Unlike hooks.json
 * there is no structured container to merge into, so OpenCadre's rules live inside a marked block and
 * a re-run replaces that one block. The markers are HTML comments: invisible to the model, obvious to a
 * human reading the file. https://antigravity.google/docs/rules/ */

export const BLOCK_BEGIN = "<!-- opencadre:begin - managed by `opencadre connect`; edits inside are overwritten -->";
export const BLOCK_END = "<!-- opencadre:end -->";

export const antigravityRulesFile = (home) => join(home, ".gemini", "GEMINI.md");

/** The rules text connect installs. The wake path is the INSTALLED helper, not a repo-relative one:
 * a customer workspace has no checkout of this repository, so `node scripts/opencadre-wake.mjs` names a
 * file that does not exist there. Keep the rule count and wording in step with
 * .agent/rules/opencadre-inbox.md, which is the same discipline for this repository's own agents. */
export const rulesBlock = ({ binDir }) => {
  const wake = join(binDir, "opencadre-wake.mjs");
  return [
    BLOCK_BEGIN,
    "",
    "# OpenCadre inbox discipline",
    "",
    "You are a member of an OpenCadre fleet. Antigravity holds no connection between steps, so messages",
    "to you wait in a queue until you check. Follow these rules on every task.",
    "",
    "1. **Check at every checkpoint.** At the start of each task and after every major step (a file",
    "   written, a command finished, a test run), call `get_awareness`. When it lists nothing, carry on.",
    "   When it lists something addressed to you (a question, an approval, a message, a file conflict),",
    "   handle it before continuing: `reply` on its thread, then `ack_event` it.",
    "2. **Never go idle silently.** When you finish a task or are blocked waiting, do not just end the",
    "   turn. Call `wait_for_message` with `timeoutSeconds: 55`, up to 10 times in a row, and answer",
    "   whatever arrives.",
    "3. **Status, not chatter.** Report routine progress with `set_status`. Use `send_message` only when",
    "   someone needs to act.",
    "4. **No ack loops.** Never reply to a pure acknowledgement (\"ok\", \"thanks\", \"pong\").",
    `5. **Keep the wake watcher running.** At session start, and every time it exits, launch`,
    `   \`node "${wake}"\` as a BACKGROUND task, never in the foreground. It costs zero tokens while`,
    "   waiting and exits when real mail arrives. That exit is what wakes you when you are idle. Read the",
    "   mail with `get_messages`, answer it, then relaunch the watcher. If it exits with",
    "   `OPENCADRE WAKE ERROR`, tell the fleet with `set_status` and relaunch it.",
    "6. **Long steps.** Before any step you expect to take more than 2 minutes (a long build, a big test",
    "   run), call `get_messages` with `peek: true` first, and again right after.",
    "",
    BLOCK_END,
  ].join("\n");
};

/** Returns { file, before, after } without writing. An existing OpenCadre block is replaced in place;
 * a file without one gets the block appended, so a customer's own rules are never touched. */
export function planAntigravityRules({ home, binDir }) {
  const file = antigravityRulesFile(home);
  const before = readText(file);
  const block = rulesBlock({ binDir });

  const start = before.indexOf(BLOCK_BEGIN);
  const end = before.indexOf(BLOCK_END);
  let after;
  if (start !== -1 && end !== -1 && end > start) {
    after = before.slice(0, start) + block + before.slice(end + BLOCK_END.length);
  } else if (!before.trim()) {
    after = `${block}\n`;
  } else {
    after = `${before.replace(/\s*$/, "")}\n\n${block}\n`;
  }
  return { file, before, after };
}