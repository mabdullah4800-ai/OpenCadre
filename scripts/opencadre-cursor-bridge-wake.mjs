#!/usr/bin/env node
// Experimental Cursor editor idle wake. Watch one OpenCadre chat's inbox and submit
// a turn to that exact completed chat through Cursor Desktop Bridge. No credential
// or message body is passed to Cursor's CLI or written to disk.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBillingReadOnly, resolveHub } from "./opencadre-config.mjs";
import { isPureAck } from "./pure-ack.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL_PAGE_LIMIT = 100;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const samePath = (a, b) => typeof a === "string" && typeof b === "string"
  && resolve(a).replaceAll("/", "\\").toLowerCase() === resolve(b).replaceAll("/", "\\").toLowerCase();

export function wakeworthy(message) {
  return message?.priority !== "low" && (message?.awaiting_reply || !isPureAck(message?.body ?? ""));
}

export function selectIdleChat(list, { chatId, profile }) {
  if (!Array.isArray(list)) return null;
  const matches = list.filter((item) => item?.id === chatId && item?.source === "local"
    && samePath(item?.instance?.userDataDir, profile));
  return matches.length === 1 && ["completed", "idle"].includes(matches[0].status) ? matches[0] : null;
}

/** Bridge accepting a turn is not delivery. Only the chat's real inbox read may move the cursor. */
export function cursorAfterConfirmation(afterId, lastId, targetIds, unreadMessages) {
  const unread = new Set(unreadMessages.map((message) => message.id));
  return targetIds.some((id) => unread.has(id)) ? afterId : lastId;
}

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--once") { values.once = true; continue; }
    if (argv[i] === "--check") { values.check = true; continue; }
    if (!["--chat", "--agent", "--project", "--profile"].includes(argv[i]) || !argv[i + 1])
      throw new Error("Usage: node opencadre-cursor-bridge-wake.mjs --chat <Cursor chat UUID> --agent <OpenCadre agent name> --project <folder> [--profile <Cursor user data folder>] [--check|--once]");
    values[argv[i].slice(2)] = argv[++i];
  }
  if (!UUID.test(values.chat ?? "") || !values.agent || !values.project || !isAbsolute(values.project))
    throw new Error("A Cursor chat UUID, expected agent name, and absolute project folder are required.");
  values.profile ??= join(process.env.APPDATA ?? "", "Cursor");
  if (!isAbsolute(values.profile)) throw new Error("The Cursor profile folder must be absolute.");
  return values;
}

function cursorLauncher() {
  if (process.platform !== "win32") throw new Error("Cursor Desktop Bridge wake currently supports Windows only.");
  const exe = join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe");
  const cli = join(dirname(exe), "resources", "app", "out", "cli.js");
  if (!existsSync(exe) || !existsSync(cli)) throw new Error("Cursor's desktop CLI was not found.");
  return { exe, cli };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function bridgeReady(profile) {
  // Cursor's CLI falls through to Electron when there is no live discovery record.
  // Check before invoking it so an idle watcher cannot open stray windows on retry.
  try {
    const dir = join(homedir(), ".cursor", "desktop-bridge");
    return readdirSync(dir).some((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
        return samePath(record.userDataDir, profile) && pidAlive(record.pid);
      } catch { return false; }
    });
  } catch { return false; }
}

function cursorCommand(launcher, argv) {
  return new Promise((done, reject) => {
    // The proxy has credentials in its own process environment. Cursor's CLI needs
    // only OS paths and Electron's Node mode, so do not inherit arbitrary variables.
    const env = Object.fromEntries(Object.entries({
      ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "", APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    }).filter(([, value]) => typeof value === "string"));
    const child = spawn(launcher.exe, [launcher.cli, "desktop", ...argv, "--json"], {
      env,
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    child.stdout.on("data", (part) => { stdout += part; if (stdout.length > 256000) child.kill(); });
    child.stderr.on("data", (part) => { stderr += part; if (stderr.length > 16000) child.kill(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Cursor Desktop Bridge command timed out."));
      if (code !== 0) return reject(new Error(`Cursor Desktop Bridge command exited ${code}.`));
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(new Error("Cursor Desktop Bridge returned invalid JSON."));
      }
      if (result?.error || result?.status === "error") return reject(new Error("Cursor Desktop Bridge refused the request."));
      done(result);
    });
  });
}

function takeLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let owner = 0;
    try { owner = Number(readFileSync(file, "utf8")); } catch {}
    if (pidAlive(owner)) throw new Error("A Cursor Bridge watcher is already running for this chat.");
    rmSync(file, { force: true });
  }
  throw new Error("Could not acquire the Cursor Bridge watcher lock.");
}

async function main() {
  const { chat, agent, project, profile, once, check } = options(process.argv.slice(2));
  const identity = resolveHub({ client: "cursor", cwd: project, sessionId: chat });
  if (!identity.key || !identity.base) throw new Error("This Cursor chat has no connected OpenCadre identity.");
  const headers = { authorization: `Bearer ${identity.key}`, ...identity.headers };
  const me = await fetch(`${identity.base}/v1/me`, { headers });
  const meData = await me.json().catch(() => ({}));
  if (!me.ok || meData.agentName !== agent) throw new Error("The Cursor chat does not resolve to the expected OpenCadre agent.");

  const launcher = cursorLauncher();
  if (check) {
    if (!bridgeReady(profile)) throw new Error("Cursor Desktop Bridge is not listening in this profile.");
    const list = await cursorCommand(launcher, ["ls"]);
    const found = list.find((item) => item?.id === chat && item?.source === "local"
      && samePath(item?.instance?.userDataDir, profile));
    if (!found) throw new Error("The exact Cursor chat is not listed in this profile's Desktop Bridge.");
    console.log(`Bridge can target ${agent}; chat status: ${found.status}. This check cannot tell whether that chat selected Opencadre Project or can call get_messages.`);
    return;
  }
  const stateDir = process.env.OPENCADRE_WAKE_STATE_DIR || join(homedir(), ".opencadre");
  const suffix = createHash("sha256").update(`${chat}\n${resolve(project)}`).digest("hex").slice(0, 16);
  const lockFile = join(stateDir, `cursor-bridge-wake-${suffix}.lock`);
  takeLock(lockFile);
  process.on("exit", () => { try { if (readFileSync(lockFile, "utf8") === String(process.pid)) rmSync(lockFile, { force: true }); } catch {} });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

  // Rebuild this cursor from unread mail on every start. A previous version
  // persisted it on Bridge submission, hiding mail that Cursor never read.
  let afterId = "";
  let unconfirmedSubmissions = 0;
  let lastBridgeWarning = 0;
  for (;;) {
    const url = `${identity.base}/v1/messages/wait?peek=true&timeoutSeconds=50&limit=${MAIL_PAGE_LIMIT}${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ""}`;
    let response;
    try { response = await fetch(url, { headers, signal: AbortSignal.timeout(70000) }); }
    catch { await pause(5000); continue; }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (isBillingReadOnly(response.status, body)) return;
      if (response.status === 429 || response.status >= 500) { await pause(5000); continue; }
      throw new Error(`OpenCadre inbox wait failed (HTTP ${response.status}).`);
    }
    const messages = (await response.json()).messages ?? [];
    if (!messages.length) { await pause(500); continue; }
    const lastId = messages.at(-1).id;
    const real = messages.filter(wakeworthy);
    if (real.length === 0) {
      afterId = lastId;
      continue;
    }
    let ready = false;
    try {
      if (!bridgeReady(profile)) throw new Error("Cursor Desktop Bridge is not listening.");
      const list = await cursorCommand(launcher, ["ls"]);
      ready = Boolean(selectIdleChat(list, { chatId: chat, profile }));
      if (ready) {
        const notice = `OpenCadre has ${real.length} unread message(s) for this Cursor chat. Call opencadre_get_messages without peek and reply on each returned threadId. If the project tools are missing, reopen the enabled project folder, then retry.`;
        const sent = await cursorCommand(launcher, ["send", chat, notice]);
        ready = sent?.status === "submitted" || sent?.status === "queued";
      }
    } catch (error) {
      ready = false;
      if (Date.now() - lastBridgeWarning > 60000) {
        console.error(`Cursor Desktop Bridge is unavailable (${error?.message ?? "unknown error"}); keeping mail unread for a retry.`);
        lastBridgeWarning = Date.now();
      }
    }
    if (!ready) { await pause(5000); continue; }
    console.log(`Submitted an inbox turn to ${agent}'s Cursor chat for ${real.length} message(s); awaiting a real inbox read.`);
    await pause(30000);
    let unread;
    try {
      // The target IDs came from the oldest 100 unread rows after this same cursor. A target
      // still unread remains within those first 100 even if newer mail arrives while Cursor runs.
      const checkUrl = `${identity.base}/v1/messages?peek=true&limit=${MAIL_PAGE_LIMIT}${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ""}`;
      const checkResponse = await fetch(checkUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (!checkResponse.ok) throw new Error(`HTTP ${checkResponse.status}`);
      unread = (await checkResponse.json()).messages ?? [];
    } catch {
      if (once) throw new Error("Bridge submitted a turn, but OpenCadre could not confirm an inbox read.");
      await pause(60000);
      continue;
    }
    const confirmed = cursorAfterConfirmation(afterId, lastId, real.map((message) => message.id), unread);
    if (confirmed === afterId) {
      unconfirmedSubmissions++;
      if (once || unconfirmedSubmissions >= 3)
        throw new Error("Bridge accepted a Cursor turn request, but that chat did not read its OpenCadre mail. Confirm get_messages is callable in that exact chat; a connected server, selected Opencadre Project, or fresh chat alone does not prove the tools loaded. The watcher left the mail unread for a later retry.");
      console.error("Cursor has not read the submitted mail; retrying after one minute.");
      await pause(60000);
      continue;
    }
    afterId = confirmed;
    unconfirmedSubmissions = 0;
    console.log(`Cursor read ${real.length} OpenCadre message(s). A reply on each thread still needs separate verification.`);
    if (once) return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
