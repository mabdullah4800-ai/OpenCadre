import { pathToFileURL } from "node:url";
import { helperSource } from "./helpers.mjs";

/** Session commands: the chat that ran `opencadre connect` (or any Claude Code chat's Bash tool) acts as its own agent
 * without a restart. Identity comes from exactly the logic the MCP proxy and the hooks use (opencadre-config.mjs, loaded
 * from the repo or the packed helpers/): a named agent for the folder wins; else this machine's device credential with
 * the session headers from CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_HOST_SESSION_ID. No session id: an error, never a guess.
 * Nothing here ever prints the key or credential. */
const config = await import(pathToFileURL(helperSource("opencadre-config.mjs")).href);
export const { resolveHub, readDeviceCredential, sessionHeaders, projectHeaders, projectIdentity, isProjectNotEnabled, syncProjectAllowlist } = config;

/** What a session command says in a project its workspace hasn't enabled. */
export const PROJECT_OFF_MESSAGE = "OpenCadre isn't enabled for this project. Enable it in the console under Settings → Projects.";

export const SESSION_COMMANDS = ["whoami", "inbox", "send", "reply", "status", "wait"];

export const SESSION_USAGE = [
  "opencadre whoami",
  "opencadre inbox [--peek]",
  'opencadre send <agent> "<message>" [--priority high|medium|low]',
  'opencadre reply <threadId> "<message>"',
  'opencadre status "<task>"',
  "opencadre wait [--seconds N] [--peek]",
].join("\n       ");

const MAX_WAIT_SECONDS = 280;
const TIMEOUT_MS = Number(process.env.OPENCADRE_CONNECT_TIMEOUT_MS) || 30_000;

const fail = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

/** Who this command acts as: { base, key, source, headers }. */
export function sessionIdentity({ client = "claude-code", home, cwd = process.cwd(), env = process.env } = {}) {
  // An explicit command from the chat itself may create its session (hooks only ever resolve one that exists).
  const hub = resolveHub({ client, cwd, home, env, create: true });
  if (hub.key) return hub;
  // Not on this computer's enabled-project list: the same sentence the hub's project_not_enabled gets, without asking.
  if (hub.notEnabled) throw Object.assign(fail(PROJECT_OFF_MESSAGE), { projectNotEnabled: true });
  if (!readDeviceCredential({ client, home, env })) {
    throw fail("OpenCadre isn't connected on this machine: run the connect command from the console.");
  }
  throw fail("No session id from Claude Code (CLAUDE_CODE_SESSION_ID isn't set), so there's no way to tell which session this is. Run it from a Claude Code chat's Bash tool.");
}

/** The key, the credential and anything shaped like one never reach the output. */
const redactor = (secret) => (text) => {
  let out = String(text);
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/\b(dev|agt|org)_[A-Za-z0-9]{8,}/g, "$1_[redacted]");
};

export async function hubCall(identity, method, path, { body, timeoutMs = TIMEOUT_MS } = {}) {
  const redact = redactor(identity.key);
  let res;
  try {
    res = await fetch(`${identity.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${identity.key}`,
        ...identity.headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fail(redact(`Could not reach ${identity.base} (${err.cause?.code ?? err.message}).`));
  }
  const data = await res.json().catch(() => ({}));
  if (identity.source === "device" && isProjectNotEnabled(res.status, data)) {
    throw Object.assign(fail(PROJECT_OFF_MESSAGE), { projectNotEnabled: true });
  }
  if (!res.ok) {
    const said = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw fail(redact(`The hub refused this (HTTP ${res.status}): ${said}`));
  }
  return data;
}

/** The session's name: joining creates it on first sight and is the same agent after /clear. */
export async function whoami(identity) {
  if (identity.source === "device") {
    const joined = await hubCall(identity, "POST", "/v1/sessions/join", { body: {} });
    const me = await hubCall(identity, "GET", "/v1/me");
    return { agentName: joined.agentName, orgName: me.orgName, named: false };
  }
  const me = await hubCall(identity, "GET", "/v1/me");
  return { agentName: me.agentName, orgName: me.orgName, named: true };
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

function formatMessages(messages, { consumed }) {
  if (!Array.isArray(messages) || messages.length === 0) return ["No new messages."];
  const lines = [`${messages.length} message${messages.length === 1 ? "" : "s"}${consumed ? " (now marked read)" : ""}:`];
  for (const m of messages) {
    const waiting = m.awaiting_reply ? " · awaiting your reply" : "";
    lines.push("", `[${m.priority}] from ${m.from_agent_name} · thread ${m.thread_id} · ${m.created_at}${waiting}`);
    for (const bodyLine of String(m.body ?? "").split(/\r?\n/)) lines.push(`  ${bodyLine}`);
  }
  lines.push("", 'Reply on a thread with: opencadre reply <threadId> "<message>"');
  return lines;
}

const textArg = (parts, what) => {
  const text = parts.join(" ").trim();
  if (!text) throw fail(`${what} is required.\nusage: ${SESSION_USAGE}`, 2);
  return text;
};

/** Runs one session command and returns the lines to print. */
export async function runSessionCommand({ name, args, values, home }) {
  // Checked before any identity lookup, so a typo never touches the hub.
  let seconds = 55;
  if (name === "wait" && values.seconds !== undefined) {
    seconds = Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail(`--seconds must be a whole number from 1 to ${MAX_WAIT_SECONDS}.`, 2);
  }
  const priority = values.priority ?? "medium";
  if (name === "send" && !["high", "medium", "low"].includes(priority)) throw fail("--priority must be high, medium or low.", 2);
  if ((name === "send" || name === "reply") && args.length < 2) {
    throw fail(`${name} needs ${name === "send" ? "an agent name" : "a thread id"} and a message.\nusage: ${SESSION_USAGE}`, 2);
  }

  const identity = sessionIdentity({ client: values.client ?? "claude-code", home });
  switch (name) {
    case "whoami": {
      const me = await whoami(identity);
      return [`You are ${me.agentName} in the OpenCadre workspace "${me.orgName}"${me.named ? " (the named agent configured for this folder)" : " (this session's own identity)"}.`];
    }
    case "inbox": {
      const { messages } = await hubCall(identity, "GET", `/v1/messages?peek=${values.peek ? "true" : "false"}`);
      return formatMessages(messages, { consumed: !values.peek });
    }
    case "wait": {
      const { messages } = await hubCall(identity, "GET", `/v1/messages/wait?timeoutSeconds=${seconds}&peek=${values.peek ? "true" : "false"}`, { timeoutMs: (seconds + 30) * 1000 });
      if (!messages?.length) return [`No new messages in ${seconds} s.`];
      return formatMessages(messages, { consumed: !values.peek });
    }
    case "send": {
      const [to, ...rest] = args;
      const sent = await hubCall(identity, "POST", "/v1/messages", { body: { toAgent: to, body: textArg(rest, "The message"), priority } });
      return [`Sent to ${oneLine(to)} (${sent.delivered ?? "queued"}). Thread: ${sent.threadId}`];
    }
    case "reply": {
      const [threadId, ...rest] = args;
      await hubCall(identity, "POST", `/v1/messages/${encodeURIComponent(threadId)}/reply`, { body: { body: textArg(rest, "The message") } });
      return [`Replied on thread ${oneLine(threadId)}.`];
    }
    case "status": {
      const task = textArg(args, "The task");
      await hubCall(identity, "POST", "/v1/status", { body: { task } });
      return [`Status set: ${oneLine(task)}`];
    }
    default:
      throw fail(`unknown command ${name}`, 2);
  }
}
