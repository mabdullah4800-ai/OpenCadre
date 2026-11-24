// OpenCode v2, LIVE: the real `opencode` binary (npm @opencode/cli, v2.x), set up in a throwaway home by `opencadre
// connect --client opencode`, driven by a scripted OpenAI-compatible model (a `provider` in its config; no account),
// against a real in-process hub. OpenCode runs as `opencode serve` with `opencode run --server` sending each prompt, so the
// server (and the plugin in it) stays up after the turn, as the background service does. Modelled on tests/kilo-live.test.ts.
// Skipped unless OPENCADRE_OPENCODE_BIN names the binary:
//   OPENCADRE_OPENCODE_BIN=/path/to/@opencode/cli-linux-x64/bin/opencode npx vitest run tests/opencode-live.test.ts
//
// It adapts to what the checkout ships:
//  - scripts/opencode-plugin/ (#585): connect installs the plugin folder and lists it under `plugins`; used as is.
//  - examples/opencode-plugin/clearance.js (#586): if connect did not install it, the test copies it beside the installed
//    plugin (or, with no plugin at all, beside a two-line index.js that only calls registerClearance), and says so.
// Each part asserts only when the checkout ships the piece it tests.
//
// The script per chat: 1) set_status (through Code Mode's `execute`), 2) for a "risky" prompt, `rm -rf ./probe-dir` in
// shell, 3) done. When the last message is OpenCadre's mail notice, the model calls get_messages, so the test can see the
// mail itself reach the model.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const OPENCODE = process.env.OPENCADRE_OPENCODE_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const REPO = process.cwd();
const SHIPS_MAIL = existsSync(path.join(REPO, "scripts", "opencode-plugin", "index.js"));
// LIVE_AS_INSTALLED=1: use exactly what connect installed (no copying), to see what a user gets.
const SHIPS_CLEARANCE = existsSync(path.join(REPO, "examples", "opencode-plugin", "clearance.js"))
  || existsSync(path.join(REPO, "scripts", "opencode-plugin", "clearance.js"));
const NOTICE = /unread OpenCadre message/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seen = { tools: string[]; body: string; last: string };
/** Code Mode (OpenCode 2.0.16): MCP tools are not offered directly; the model calls `execute` with JavaScript that finds
 * the tool with `search` and calls it by its catalog path. MEASURED: an MCP server still "pending" when a session starts
 * is missing from that session's catalog, so the script reports NOT_FOUND and the model asks again. */
const codeCall = (tool: string, args: object, tag: string) => `const hit = search({ query: ${JSON.stringify(tool)} }).items.find((i) => i.path.endsWith(${JSON.stringify(tool)}) || i.path.endsWith(${JSON.stringify(`["${tool}"]`)}));
if (!hit) return "NOT_FOUND ${tool}";
let fn = tools;
for (const m of hit.path.replace(/^tools/, "").matchAll(/\\.([A-Za-z_$][\\w$]*)|\\["([^"]+)"\\]/g)) fn = fn[m[1] ?? m[2]];
return "${tag} " + hit.path + " " + JSON.stringify(await fn(${JSON.stringify(args)}));`;

/** The scripted model, driven by the last message: prompt -> set_status (task names the prompt); SET_OK -> for a "risky"
 * prompt, `rm -rf ./probe-dir` in shell, else done; a mail notice -> get_messages; anything else -> done. */
async function model() {
  const seen: Seen[] = [];
  const server = createHttp((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
      }
      let body: { tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role: string; content?: unknown }> } = {};
      try { body = JSON.parse(raw); } catch { /* empty */ }
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "");
      const messages = body.messages ?? [];
      const last = JSON.stringify(messages.at(-1) ?? {});
      seen.push({ tools, body: raw, last });
      const firstUser = String(messages.find((m) => m.role === "user")?.content ?? "").replace(/[^A-Za-z0-9 ]/g, "").trim();
      let call: { name: string; arguments: string } | null = null;
      const exec = (code: string) => ({ name: "execute", arguments: JSON.stringify({ code }) });
      if (tools.includes("execute")) {
        const lastRole = messages.at(-1)?.role;
        if (NOTICE.test(last)) call = exec(codeCall("get_messages", {}, "MAIL"));
        else if (/NOT_FOUND set_status/.test(last)) { await sleep(500); call = exec(codeCall("set_status", { task: `live opencode ${firstUser}` }, "SET_OK")); }
        else if (/NOT_FOUND get_messages/.test(last)) { await sleep(500); call = exec(codeCall("get_messages", {}, "MAIL")); }
        else if (/lapsed plain tool/.test(firstUser) && !messages.some((m) => m.role === "tool")) {
          call = { name: "shell", arguments: JSON.stringify({ command: "rm -rf ./__oc_lapsed_nonexistent__; echo OC_LAPSED_OK", description: "lapsed workspace probe" }) };
        }
        else if (/shell first/.test(firstUser) && !messages.some((m) => m.role === "tool")) call = { name: "shell", arguments: JSON.stringify({ command: "rm -rf ./probe-dir", description: "clean" }) };
        else if (/shell first/.test(firstUser) && !/SET_OK/.test(JSON.stringify(messages))) call = exec(codeCall("set_status", { task: `live opencode ${firstUser}` }, "SET_OK"));
        else if (lastRole === "user") call = exec(codeCall("set_status", { task: `live opencode ${firstUser}` }, "SET_OK"));
        else if (/SET_OK/.test(last) && /risky/.test(firstUser)) call = { name: "shell", arguments: JSON.stringify({ command: "rm -rf ./probe-dir", description: "clean" }) };
      }
      const id = `c${seen.length}`;
      const ev = (d: object) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "test-model", ...d })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (call) {
        ev({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: call }] }, finish_reason: null }] });
        ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        ev({ choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
        ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      ev({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

describe.skipIf(!OPENCODE || !existsSync(OPENCODE))("OpenCode LIVE: the real binary, our plugin, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let llm: Awaited<ReturnType<typeof model>>;
  let env: Record<string, string>;
  let port: number;
  let out = "";
  const notes: string[] = [];
  const project = gitProject("OpenCodeLive");
  const procs: ChildProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("OpenCode Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:opencodelive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-opencode-live-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "opencode"], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(connected.code, connected.err + connected.out).toBe(0);
    llm = await model();
    const dir = path.join(home, ".config", "opencode");
    const file = ["opencode.jsonc", "opencode.json"].map((f) => path.join(dir, f)).find((f) => existsSync(f))!;
    const config = JSON.parse(readFileSync(file, "utf8"));
    const bin = path.join(home, ".opencadre", "bin");
    const pluginDir = path.join(bin, "opencode-plugin");
    notes.push(`connect wrote ${path.basename(file)}; plugins=${JSON.stringify(config.plugins ?? null)}; mcp.servers=${Object.keys(config.mcp?.servers ?? {}).join(",")}`);
    if (process.env.LIVE_AS_INSTALLED) {
      expect(config.plugins).toContain(pluginDir);
      for (const name of ["index.js", "mail.js", "clearance.js"]) {
        expect(existsSync(path.join(pluginDir, name)), `connect did not install ${name}`).toBe(true);
      }
    }
    if (SHIPS_CLEARANCE && !existsSync(path.join(pluginDir, "clearance.js")) && !process.env.LIVE_AS_INSTALLED) {
      mkdirSync(pluginDir, { recursive: true });
      const src = [path.join(REPO, "scripts", "opencode-plugin", "clearance.js"), path.join(REPO, "examples", "opencode-plugin", "clearance.js")].find(existsSync)!;
      copyFileSync(src, path.join(pluginDir, "clearance.js"));
      notes.push(`connect did NOT install clearance.js; the test copied ${path.relative(REPO, src)} into the plugin folder`);
      if (!existsSync(path.join(pluginDir, "index.js"))) {
        writeFileSync(path.join(pluginDir, "index.js"), 'import { registerClearance } from "./clearance.js"\nexport default { id: "opencadre-clearance-test", async setup(ctx) { await registerClearance(ctx) } }\n');
        notes.push("no plugin entry shipped: the test wrote a two-line index.js that calls registerClearance");
      }
    }
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    if (existsSync(pluginDir) && !plugins.includes(pluginDir)) plugins.push(pluginDir);
    writeFileSync(file, JSON.stringify({
      ...config,
      plugins,
      provider: { scripted: { npm: "@ai-sdk/openai-compatible", options: { baseURL: llm.url, apiKey: "test" }, models: { "test-model": { tool_call: true } } } },
      model: "scripted/test-model",
    }, null, 2));
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");

    env = {
      ...childEnv(home, { XDG_CONFIG_HOME: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      // `serve` requires a password (it prints a random one otherwise); `run --server` sends the same variable.
      OPENCODE_SERVER_PASSWORD: `live-${Math.random().toString(36).slice(2)}`,
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      ...(process.env.LIVE_BACKOFF_MS ? { OPENCADRE_OPENCODE_BACKOFF_MS: process.env.LIVE_BACKOFF_MS } : {}),
      PWD: project,
    };
    port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const { port: p } = s.address() as AddressInfo;
        s.close(() => resolve(p));
      });
    });
    const server = spawn(OPENCODE!, ["serve", "--port", String(port), "--print-logs", "--log-level", process.env.LIVE_LOG_LEVEL ?? "warn"], { cwd: project, env });
    server.stdout.on("data", (c) => (out += c));
    server.stderr.on("data", (c) => (out += c));
    procs.push(server);
    for (let i = 0; i < 300; i++) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
      await sleep(100);
    }
  }, 90_000);

  afterAll(async () => {
    console.log(`[opencode-live] ${notes.join("\n[opencode-live] ")}`);
    if (process.env.LIVE_DUMP) writeFileSync(process.env.LIVE_DUMP, `${out}\n---- model saw ----\n${llm?.seen.map((s) => `tools=${s.tools.join(",")} last=${s.last.slice(0, 400)}`).join("\n")}\n`);
    for (const p of procs) p.kill();
    await llm?.close();
    await hub?.close();
  });

  const run = (prompt: string) => {
    const child = spawn(OPENCODE!, ["run", "--server", `http://127.0.0.1:${port}`, "--format", "json", "--auto", prompt], { cwd: project, env });
    child.stdin.end(); // `run` reads a piped stdin as more message and waits for it to close (measured: it hangs otherwise)
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    procs.push(child);
    return new Promise<number | null>((r) => child.on("close", r));
  };
  const agentFor = async (task: string) => {
    for (let i = 0; i < 600; i++) {
      const found = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === task)?.agentName;
      if (found) return found;
      await sleep(100);
    }
    return undefined;
  };
  const send = (to: string, body: string) => fetch(`${hub.url}/v1/messages`, {
    method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ toAgent: to, body, priority: "high" }),
  });
  let agent: string | undefined;

  it(SHIPS_CLEARANCE
    ? "a chat's risky shell command is held as the chat's own agent, and a denial keeps the fixture"
    : "a chat's OpenCadre calls act as its own agent (no clearance shipped in this checkout: #586)", async () => {
    const exited = run("risky one");
    agent = await agentFor("live opencode risky one");
    expect(agent, out).toMatch(/^OpenCode-OpenCodeLive-/);
    if (!SHIPS_CLEARANCE) {
      expect(await exited, out).toBe(0);
      notes.push(`no clearance shipped: probe-dir survived? ${existsSync(path.join(project, "probe-dir", "keep.txt"))}`);
      return;
    }
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; action: string; details: string }> = [];
    for (let i = 0; i < 600 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await sleep(100);
    }
    expect(pending, out).toHaveLength(1);
    notes.push(`held: action=${JSON.stringify(pending[0].action)} by ${pending[0].requested_by_agent_name}; details=${JSON.stringify(pending[0].details)}`);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true); // still held: nothing ran yet
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });
    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = llm.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
  });

  it.skipIf(!SHIPS_CLEARANCE)("a chat whose FIRST act is the risky command is held as the same agent its later OpenCadre calls use", async () => {
    const { listApprovals } = await import("../src/approvals.js");
    const already = new Set((listApprovals(orgId, {}) as Array<{ id: string }>).map((a) => a.id));
    const exited = run("shell first");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 600 && pending.length === 0; i++) {
      pending = (listApprovals(orgId, { status: "pending" }) as typeof pending).filter((a) => !already.has(a.id));
      if (pending.length === 0) await sleep(100);
    }
    expect(pending, out).toHaveLength(1);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "first-act denial" });
    expect(await exited, out).toBe(0);
    const later = await agentFor("live opencode shell first");
    notes.push(`shell-first chat: held as ${pending[0].requested_by_agent_name}; its later set_status landed on ${later}`);
    expect(later).toBe(pending[0].requested_by_agent_name);
    expect(later).not.toBe(agent);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
  });

  it("each chat is its own agent", async () => {
    expect(await run("second chat"), out).toBe(0);
    const second = await agentFor("live opencode second chat");
    expect(second).toMatch(/^OpenCode-OpenCodeLive-/);
    expect(second).not.toBe(agent);
    notes.push(`two chats -> two agents: ${agent} / ${second}`);
  });

  it.skipIf(!SHIPS_MAIL)("mail sent to an idle chat wakes it, and the mail itself reaches the model", async () => {
    expect(agent).toBeDefined();
    const before = llm.seen.length;
    await sleep(1500);
    const sentAt = Date.now();
    await send(agent!, "idle mail for opencode");
    let woke = -1;
    for (let i = 0; i < 1200 && woke < 0; i++) {
      woke = llm.seen.slice(before).findIndex((s) => NOTICE.test(s.last));
      if (woke < 0) await sleep(100);
    }
    notes.push(`idle wake: ${woke >= 0 ? `notice reached the model ${Date.now() - sentAt} ms after send` : "NO wake within 120 s"}`);
    expect(woke, out).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 300 && !llm.seen.slice(before).some((s) => /idle mail for opencode/.test(s.body)); i++) await sleep(100);
    expect(llm.seen.slice(before).map((s) => s.body).join("\n"), out).toMatch(/idle mail for opencode/);
    // One wake per mail: wait a little and count notices as the LAST message (the turn the wake started).
    await sleep(3000);
    const wakes = llm.seen.slice(before).filter((s) => NOTICE.test(s.last)).length;
    notes.push(`notices admitted for one mail: ${wakes}`);
    expect(wakes).toBe(1);
  });

  it("doctor confirms the connected profile and rejects a disconnected profile", async () => {
    const connected = await runNode(CLI, ["doctor", "--client", "opencode", "--home", home], childEnv(home, { XDG_CONFIG_HOME: "" }));
    notes.push(`doctor connected: exit=${connected.code}; ${connected.out.trim().split(/\r?\n/).at(-1)}`);
    expect(connected.code, connected.err + connected.out).toBe(0);
    expect(connected.out).toContain("verdict=healthy");

    const emptyHome = tempDir("oc-opencode-doctor-empty-");
    const missing = await runNode(CLI, ["doctor", "--client", "opencode", "--home", emptyHome], childEnv(emptyHome, { XDG_CONFIG_HOME: "" }));
    notes.push(`doctor disconnected: exit=${missing.code}; ${missing.out.trim().split(/\r?\n/).at(-1)}`);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("verdict=not_connected");
  });

  it("leaves a new chat's shell usable when the workspace trial has lapsed", async () => {
    const { db } = await import("../src/db.js");
    const { assignPlan, workspaceBilling } = await import("../src/billing.js");
    assignPlan(orgId, "trial");
    db.prepare("UPDATE organizations SET trial_ends_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), orgId);
    expect(workspaceBilling(orgId).readOnly).toBe(true);
    const before = llm.seen.length;
    expect(await run("lapsed plain tool"), out).toBe(0);
    const toolOutput = llm.seen.slice(before)
      .flatMap((s) => (JSON.parse(s.body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content)).join("\n");
    notes.push(`lapsed trial: shell output reached model=${toolOutput.includes("OC_LAPSED_OK")}`);
    expect(toolOutput).toContain("OC_LAPSED_OK");
    expect(toolOutput).not.toMatch(/OpenCadre approval gate:|denied by Operator/);
  });
});
