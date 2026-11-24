#!/usr/bin/env node
/**
 * DSH session-identity hook: gives each DeepSeek Harness chat its OWN OpenCadre identity.
 *
 * THE PROBLEM THIS SOLVES. Before this hook, a DSH chat reached OpenCadre with a static agent
 * key and NO session header, so the hub saw ONE agent no matter how many DSH chats were running.
 * Every chat was the same agent to OpenCadre, because nothing in the request distinguished them.
 * That is the whole gap: not "DSH has no identity" but "DSH has no PER-CHAT identity".
 *
 * HOW IT WORKS. DSH invokes a hook with a JSON payload on stdin containing `session_id` for the
 * chat it is running. This forwards that id to resolveHub as the client "dsh", exactly as the
 * Claude Code and Codex paths do (#197/#203 established the pattern: read stdin, pass session_id,
 * forward the returned headers). The hub then attributes the request to the right chat.
 *
 * WHY IT RESOLVES FROM THE ENVIRONMENT RATHER THAN THE SESSION STORE. The DSH session store holds
 * two directory shapes for live sessions - `session-<uuid>` and bare `<uuid>` - and only 8 of 18
 * carry the prefix. A reader matching /^session-/ would see 44% of chats and miss the newest.
 * `env:DSH_SESSION_ID` needs no store-walking and no prefix guess. See the `dsh` row in
 * scripts/opencadre-clients.mjs, which carries the full note.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. Whether a DSH id survives /clear, compaction and restart
 * is being measured live (#207). If it churns, this hook is unaffected - it forwards whatever id
 * DSH supplies - but the id SOURCE becomes a keeper variable and that is new machinery. This file
 * does not guess which.
 *
 * FAIL CLOSED. If there is no session id, this does NOT substitute a default and does NOT fall
 * back to a shared identity: a defaulted id would name a different session, and with a
 * machine-wide credential it would silently make every chat on the box one agent. It exits
 * quietly having done nothing, which is the same contract as the other hooks.
 */
import { isProjectNotEnabled, resolveHub } from "../../scripts/opencadre-config.mjs";

const CLIENT = "dsh";

/** Nothing to do and nothing to say: a hook must never disturb the chat it runs inside. */
function silent() {
  process.exit(0);
}

/**
 * Read the hook payload without waiting for end-of-input.
 *
 * DSH DOES NOT CLOSE A HOOK'S STDIN. Waiting for the `end` event - the obvious
 * `for await (const chunk of process.stdin)` - means this process never exits and hook
 * processes accumulate for the life of the session. That defect is invisible in a test
 * harness that closes stdin, which is exactly how it survives review: it works where it is
 * tested and leaks where it runs.
 *
 * So: collect what arrives, then act. The payload is a single JSON object written once, so a
 * short settle is enough, and the deadline is the backstop for a harness that writes and
 * then stays open. Either way this file exits - a hook must never outlive its turn.
 */
const STDIN_SETTLE_MS = 50;
const STDIN_DEADLINE_MS = 500;

function readPayload() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      clearTimeout(deadline);
      resolve(raw);
    };
    // The deadline fires even if no data ever arrives, so a hook invoked with no stdin at all
    // still exits rather than parking a process.
    const deadline = setTimeout(finish, STDIN_DEADLINE_MS);
    // Settle shortly after the first chunk: the payload is written once, not streamed.
    let settle = setTimeout(finish, STDIN_SETTLE_MS);
    process.stdin.on("data", (chunk) => {
      raw += chunk;
      clearTimeout(settle);
      settle = setTimeout(finish, STDIN_SETTLE_MS);
    });
    // A harness that DOES close stdin resolves immediately - the well-behaved path.
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

async function main() {
  const raw = await readPayload();

  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    // A malformed payload is the harness's problem, not something to fail a chat over.
    silent();
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  // No session id -> no per-chat identity -> do nothing rather than act as somebody else.
  if (!sessionId) silent();

  // resolveHub refuses rather than substitutes when it cannot name a session, so a refusal here
  // is a legitimate outcome and is treated as "no identity", never as an error to paper over.
  const { base, key, headers = {} } = resolveHub({
    client: CLIENT,
    cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
    sessionId,
  });
  if (!base || !key) silent();

  // The hub returns this when the chat has no session yet. It is expected on a first call and is
  // not an error; the other hooks treat it the same way.
  const request = async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${key}`, ...headers },
      signal: AbortSignal.timeout(5000),
    });
    if (isProjectNotEnabled(res.status)) silent();
    return res;
  };

  try {
    // Resolve-only: a hook never creates a session. It asks the hub who this chat is, and
    // whatever the answer, the chat continues. The point is that the REQUEST carries the
    // session header, so the hub attributes it to this chat rather than to the machine.
    await request("/v1/agents");
  } catch {
    // Offline, unreachable, or refused: a hook must never block the chat it runs inside.
  }
  silent();
}

void main();