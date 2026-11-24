// Amp: the capabilities of LAUNCH-CLIENT-GATE.md §1 that can be exercised without a signed-in Amp, driven the way Amp
// drives a plugin. Shapes from Amp's plugin API reference (ampcode.com/manual/plugin-api, read 2026-09-24):
//   tool.call   { toolUseID, tool, input, thread: { id } } -> { action: "modify", input } REPLACES the input;
//               { action: "reject-and-continue", message }; nothing = no opinion. MCP tools are `mcp__<server>__<tool>`.
//   agent.start / agent.end   { thread: { id }, … }; agent.end -> { action: "continue", userMessage, maxContinuations }
//   amp.threads.get(id).appendUserMessage({ type: "user-message", content })   prompts a thread from outside a handler
//   amp.system.workspaceRoot (a file URI), amp.helpers.filePathFromURI / shellCommandFromToolCall
// The plugin under test is the copy `connect` installed into ~/.opencadre/bin, loaded through the wrapper it wrote into
// Amp's plugin folder, so the import rewrite and the wrapper are exercised too.
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

/** The environment Amp and connect see: never a machine XDG_CONFIG_HOME, so the Amp folder is the home's own. */
const ampEnv = (home: string, extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", ...extra });

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

type Handler = (event: unknown) => unknown;
type PluginFactory = (opts: object) => (amp: object) => void;

/** A stand-in for Amp's PluginAPI: the members the plugin uses, recording what it asks Amp to do. */
function fakeAmp(project: string) {
  const handlers: Record<string, Handler> = {};
  const appended: Array<{ thread: string; message: { type: string; content: string } }> = [];
  const disposers: Array<() => void> = [];
  const api = {
    on: (event: string, fn: Handler) => { handlers[event] = fn; },
    onDispose: (fn: () => void) => { disposers.push(fn); },
    system: { workspaceRoot: pathToFileURL(project).href },
    helpers: {
      filePathFromURI: (uri: string) => fileURLToPath(uri),
      shellCommandFromToolCall: (e: { tool: string; input: { cmd?: string } }) => (e.tool === "Bash" ? { command: e.input.cmd } : null),
    },
    threads: { get: (thread: string) => ({ appendUserMessage: async (message: { type: string; content: string }) => { appended.push({ thread, message }); } }) },
  };
  return { api, handlers, appended, dispose: () => disposers.forEach((d) => d()) };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("Amp, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  let createPlugin: PluginFactory;
  let amp: ReturnType<typeof fakeAmp>;
  const project = gitProject("AmpProj");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Amp Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:ampproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-amp-e2e-");
    // A user's own Amp settings and MCP server, which connect must keep.
    mkdirSync(path.join(home, ".config", "amp"), { recursive: true });
    writeFileSync(path.join(home, ".config", "amp", "settings.json"), JSON.stringify({ "amp.dangerouslyAllowAll": false, "amp.mcpServers": { linear: { url: "https://mcp.linear.app/mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "amp"], ampEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
    const wrapper = readFileSync(path.join(home, ".config", "amp", "plugins", "opencadre.js"), "utf8");
    const target = /from ("[^"]+")/.exec(wrapper)![1];
    ({ createPlugin } = await import(JSON.parse(target)) as { createPlugin: PluginFactory });
    amp = fakeAmp(project);
    createPlugin({ env: { ...ampEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" }, waitSeconds: 2, retryMs: 50, graceMs: 300 })(amp.api);
  }, 60_000);

  afterAll(async () => {
    amp?.dispose();
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const proxy = async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "amp");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  /** What Amp does with a tool.call answer: `modify` replaces the input; nothing leaves it as it was. */
  const asAmpWould = async (thread: string, tool: string, input: Record<string, unknown>) => {
    const answer = await amp.handlers["tool.call"]({ toolUseID: `tu-${Math.random()}`, tool, input, thread: { id: thread } }) as { action: string; input: Record<string, unknown> } | undefined;
    if (answer === undefined) return input;
    expect(answer.action).toBe("modify");
    return answer.input;
  };

  it("connect wrote the server into amp.mcpServers and the plugin into Amp's plugin folder, keeping the user's own", () => {
    const settings = JSON.parse(readFileSync(path.join(home, ".config", "amp", "settings.json"), "utf8"));
    expect(settings["amp.dangerouslyAllowAll"]).toBe(false);
    expect(settings["amp.mcpServers"].linear).toEqual({ url: "https://mcp.linear.app/mcp" });
    expect(settings["amp.mcpServers"]["opencadre-session"]).toEqual({ command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "amp"] });
    const wrapper = readFileSync(path.join(home, ".config", "amp", "plugins", "opencadre.js"), "utf8");
    expect(wrapper).toContain(pathToFileURL(path.join(bin, "opencadre-amp-plugin.mjs")).href);
    expect(typeof createPlugin).toBe("function");
    expect(stampActive({ client: "amp", home, env: ampEnv(home) })).toBe(true);
  });

  it("starting Amp mints NO agent, and an unstamped call is refused rather than pooled", async () => {
    const p = await proxy();
    const names = ((await p.request("tools/list", {})).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("set_status");
    const res = await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } });
    expect(res.error?.message).toMatch(/no identity stamp/);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("the plugin returns EVERY argument plus the thread's stamp, and only on OpenCadre's own server", async () => {
    // Amp turns the server's hyphen into `_` (mcp__opencadre_session__…); the hyphen form is accepted too.
    expect((await asAmpWould("T-aaaa", "mcp__opencadre-session__whoami", {}))[STAMP_FIELD]).toBeDefined();
    const args = { task: "reviewing", files: ["a.ts"] };
    const { [STAMP_FIELD]: stamp, ...rest } = await asAmpWould("T-aaaa", "mcp__opencadre_session__set_status", args);
    expect(rest).toEqual(args);
    expect(verifyStamp(credential, stamp)).toEqual({ ok: true, sessionId: "T-aaaa" });
    expect(await amp.handlers["tool.call"]({ toolUseID: "x", tool: "mcp__linear__set_status", input: args, thread: { id: "T-aaaa" } })).toBeUndefined();
    expect(await amp.handlers["tool.call"]({ toolUseID: "x", tool: "Read", input: { path: "a.ts" }, thread: { id: "T-aaaa" } })).toBeUndefined();
  });

  it("two Amp threads are two agents, each call landing on its own", async () => {
    const p = await proxy();
    await p.callTool("set_status", await asAmpWould("T-aaaa", "mcp__opencadre_session__set_status", { task: "thread A at work" }));
    await p.callTool("set_status", await asAmpWould("T-bbbb", "mcp__opencadre_session__set_status", { task: "thread B at work" }));
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["amp", "amp"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "amp", projectName: "AmpProj" });
    expect(rows.map((r) => r.currentTask).sort()).toEqual(["thread A at work", "thread B at work"]);
  });

  const agentOf = async (task: string) => ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>)
    .find((r) => r.currentTask === task)!.agentName;
  const send = async (toAgent: string, body: string) => {
    const sent = await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent, body, priority: "high" }),
    });
    expect(sent.status).toBe(201);
  };

  const end = (thread: string, message: string, status = "done") =>
    amp.handlers["agent.end"]({ thread: { id: thread }, message, id: `m-${Math.random()}`, status, messages: [] }) as Promise<{ action: string; userMessage: string; maxContinuations: number } | undefined>;
  const start = (thread: string, message: string) => amp.handlers["agent.start"]({ thread: { id: thread }, message, id: `m-${Math.random()}` });
  const appendedTo = (thread: string) => amp.appended.filter((a) => a.thread === thread);

  it("MAIL: unread mail at the end of a user's turn continues it once, with the notice; the other thread is left alone", async () => {
    await start("T-aaaa", "hi");
    await send(await agentOf("thread A at work"), "amp, please look");
    const onA = await end("T-aaaa", "hi");
    expect(onA).toMatchObject({ action: "continue", maxContinuations: 1 });
    expect(onA!.userMessage).toMatch(/amp, please look/);
    expect(await end("T-bbbb", "hi")).toBeUndefined();
    // Amp honours it: the continuation starts with our notice, and nothing is appended on top of it.
    await start("T-aaaa", onA!.userMessage);
    await new Promise((r) => setTimeout(r, 600));
    expect(appendedTo("T-aaaa")).toEqual([]);
  });

  it("a reply that arrives DURING our continuation is delivered to the idle thread, not by a second continuation Amp would ignore", async () => {
    await send(await agentOf("thread A at work"), "the reply to your answer");
    // The continued turn ends. Continuing it again would be a second plugin continuation in a row, which Amp ignores.
    expect(await end("T-aaaa", "You have 1 unread OpenCadre message(s). Read them with get_messages…")).toBeUndefined();
    await until(() => appendedTo("T-aaaa").length > 0);
    expect(appendedTo("T-aaaa")).toHaveLength(1);
    expect(appendedTo("T-aaaa")[0].message).toMatchObject({ type: "user-message", content: expect.stringMatching(/the reply to your answer/) });
    expect(appendedTo("T-aaaa")[0].message.content).not.toMatch(/please look/);
  });

  it("IDLE WAKE: a thread idle after its own turn gets ONE message when new mail arrives", async () => {
    await start("T-aaaa", appendedTo("T-aaaa")[0].message.content);
    expect(await end("T-aaaa", appendedTo("T-aaaa")[0].message.content)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(appendedTo("T-aaaa")).toHaveLength(1);
    await send(await agentOf("thread A at work"), "are you there, amp?");
    await until(() => appendedTo("T-aaaa").length > 1);
    expect(appendedTo("T-aaaa")).toHaveLength(2);
    expect(appendedTo("T-aaaa")[1].message.content).toMatch(/are you there, amp\?/);
    expect(appendedTo("T-aaaa")[1].message.content).not.toMatch(/reply to your answer/);
    await start("T-aaaa", appendedTo("T-aaaa")[1].message.content);
    await end("T-aaaa", appendedTo("T-aaaa")[1].message.content);
  });

  it("a continuation Amp does NOT honour (another plugin's came first) is delivered by the watcher instead", async () => {
    await start("T-bbbb", "work");
    await send(await agentOf("thread B at work"), "for B at turn end");
    const onB = await end("T-bbbb", "work");
    expect(onB).toMatchObject({ action: "continue" });
    // No agent.start follows: Amp ignored it. After the grace period the watcher appends the same mail.
    await until(() => appendedTo("T-bbbb").length > 0);
    expect(appendedTo("T-bbbb")[0].message.content).toMatch(/for B at turn end/);
    await start("T-bbbb", appendedTo("T-bbbb")[0].message.content);
    await end("T-bbbb", appendedTo("T-bbbb")[0].message.content);
  });

  it("a turn the user CANCELLED is never continued, and mail already waiting does not wake it", async () => {
    await start("T-bbbb", "long job");
    await send(await agentOf("thread B at work"), "sent before the cancel");
    expect(await end("T-bbbb", "long job", "cancelled")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 800));
    expect(appendedTo("T-bbbb")).toHaveLength(1);
    // The next turn the user starts ends with it.
    await start("T-bbbb", "next");
    expect((await end("T-bbbb", "next"))?.userMessage).toMatch(/sent before the cancel/);
    await start("T-bbbb", "You have 1 unread OpenCadre message(s).");
    await end("T-bbbb", "You have 1 unread OpenCadre message(s).");
  });

  it("an idle thread whose turn starts stops being watched", async () => {
    const before = appendedTo("T-bbbb").length;
    await start("T-bbbb", "go");
    await send(await agentOf("thread B at work"), "for B, while busy");
    await new Promise((r) => setTimeout(r, 2500));
    expect(appendedTo("T-bbbb")).toHaveLength(before);
    // Its turn ends: that turn continues with the mail (it was not told yet).
    expect((await end("T-bbbb", "go"))?.userMessage).toMatch(/for B, while busy/);
    await start("T-bbbb", "You have 1 unread OpenCadre message(s).");
    await end("T-bbbb", "You have 1 unread OpenCadre message(s).");
  });

  it("CLEARANCE: a risky shell command is held, asked for as the thread's agent, and a denial rejects the call", async () => {
    const call = amp.handlers["tool.call"]({ toolUseID: "tu-rm", tool: "Bash", input: { cmd: "rm -rf ./src" }, thread: { id: "T-aaaa" } }) as Promise<{ action: string; message: string }>;
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    await until(() => (pending = listApprovals(orgId, { status: "pending" }) as typeof pending).length > 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Amp wants to run this shell command in .*AmpProj/);
    expect(pending[0].requested_by_agent_name).toBe(await agentOf("thread A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(await call).toEqual({ action: "reject-and-continue", message: expect.stringMatching(/denied by Operator: no/) });
    // A harmless command: no opinion, so Amp's own permissions decide.
    expect(await amp.handlers["tool.call"]({ toolUseID: "tu-ls", tool: "Bash", input: { cmd: "git status" }, thread: { id: "T-aaaa" } })).toBeUndefined();
  });

  it("doctor --client amp finds the server and the plugin, and says so when the plugin is gone", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "amp", "--home", home], ampEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
    const wrapper = path.join(home, ".config", "amp", "plugins", "opencadre.js");
    const text = readFileSync(wrapper, "utf8");
    rmSync(wrapper);
    try {
      const gone = await runNode(CLI, ["doctor", "--client", "amp", "--home", home], ampEnv(home));
      expect(gone.out).toMatch(/hooks=missing/);
      expect(stampActive({ client: "amp", home, env: ampEnv(home) })).toBe(false);
    } finally {
      writeFileSync(wrapper, text);
    }
  });
});

describe("the Amp plugin when the hub says no", () => {
  const base = { thread: { id: "T-cccc" }, message: "done", id: "m", status: "done", messages: [] };

  it("a lapsed bill (402) is silent: no continuation, no watcher, nothing appended", async () => {
    const home = tempDir("oc-amp-402-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://hub.invalid", credential: `dev_${"0".repeat(48)}`, deviceId: "d" } }));
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ code: "TRIAL_EXPIRED" }), { status: 402 }); };
    const { createPlugin } = await import("../examples/hooks/opencadre-amp-plugin.mjs") as { createPlugin: PluginFactory };
    const amp = fakeAmp(gitProject("AmpLapsed"));
    createPlugin({ env: childEnv(home), fetchImpl, waitSeconds: 1, retryMs: 10 })(amp.api);
    expect(await amp.handlers["agent.end"](base)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1); // the turn-end peek only: a lapsed bill starts no watcher
    expect(amp.appended).toEqual([]);
    amp.dispose();
  });

  it("a thread with no agent yet is asked about a bounded number of times, then left alone", async () => {
    const home = tempDir("oc-amp-401-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://hub.invalid", credential: `dev_${"0".repeat(48)}`, deviceId: "d" } }));
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ error: "no OpenCadre session for this chat yet" }), { status: 401 }); };
    const { createPlugin } = await import("../examples/hooks/opencadre-amp-plugin.mjs") as { createPlugin: PluginFactory };
    const amp = fakeAmp(gitProject("AmpNoSession"));
    createPlugin({ env: childEnv(home), fetchImpl, waitSeconds: 1, retryMs: 10 })(amp.api);
    expect(await amp.handlers["agent.end"](base)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(4); // the turn-end peek, then three tries
    expect(amp.appended).toEqual([]);
    amp.dispose();
  });
});

describe("the Amp plugin's idle watcher backs off", () => {
  it("a hub answering 500 is retried with a pause and a bound, never in a tight loop", async () => {
    const home = tempDir("oc-amp-500-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://hub.invalid", credential: `dev_${"0".repeat(48)}`, deviceId: "d" } }));
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response("{}", { status: 500 }); };
    const { createPlugin } = await import("../examples/hooks/opencadre-amp-plugin.mjs") as { createPlugin: PluginFactory };
    const amp = fakeAmp(gitProject("Amp500"));
    createPlugin({ env: childEnv(home), fetchImpl, waitSeconds: 1, retryMs: 20 })(amp.api);
    await amp.handlers["agent.end"]({ thread: { id: "T-dddd" }, message: "done", id: "m", status: "done", messages: [] });
    await new Promise((r) => setTimeout(r, 450));
    // 100 ms between tries: the turn-end peek plus about five waits, not thousands.
    expect(calls).toBeGreaterThan(2);
    expect(calls).toBeLessThan(10);
    amp.dispose();
    await new Promise((r) => setTimeout(r, 150));
    const after = calls;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(after);
  });
});

/** A hub stand-in that serves one inbox: peek returns every message, wait returns those after `afterId` (holding
 * briefly when there are none), and `failNext` answers the next N requests with HTTP 500. */
function fakeInbox() {
  const inbox: Array<{ id: string; body: string; priority: string; from_agent_name: string; awaiting_reply: boolean }> = [];
  let failNext = 0;
  let n = 0;
  const fetchImpl = async (url: string) => {
    if (failNext > 0) {
      failNext--;
      return new Response("{}", { status: 500 });
    }
    const u = new URL(url);
    if (u.pathname.endsWith("/wait")) {
      const after = u.searchParams.get("afterId");
      const since = () => (after ? inbox.slice(inbox.findIndex((m) => m.id === after) + 1) : inbox.slice());
      for (let i = 0; i < 10 && since().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      return Response.json({ messages: since() });
    }
    return Response.json({ messages: inbox.slice() });
  };
  return {
    fetchImpl,
    add: (body: string) => inbox.push({ id: `msg-${++n}`, body, priority: "high", from_agent_name: "Peer", awaiting_reply: false }),
    fail: (k: number) => { failNext = k; },
  };
}

describe("the Amp plugin's watcher under races and failures (review of 597af1c)", () => {
  const withCredential = (prefix: string) => {
    const home = tempDir(prefix);
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://hub.invalid", credential: `dev_${"0".repeat(48)}`, deviceId: "d" } }));
    return home;
  };
  const turnEnd = (thread: string, message = "work", status = "done") => ({ thread: { id: thread }, message, id: "m", status, messages: [] });

  it("S2: a turn that starts and ends while the watcher is pausing leaves the thread watched", async () => {
    const hub = fakeInbox();
    const { createPlugin } = await import("../examples/hooks/opencadre-amp-plugin.mjs") as { createPlugin: PluginFactory };
    const amp = fakeAmp(gitProject("AmpRace"));
    createPlugin({ env: ampEnv(withCredential("oc-amp-race-")), fetchImpl: hub.fetchImpl, waitSeconds: 1, retryMs: 60, graceMs: 50 })(amp.api);
    hub.fail(2); // the turn-end peek and the watcher's first wait fail: the watcher pauses 300 ms
    await amp.handlers["agent.end"](turnEnd("T-race"));
    await new Promise((r) => setTimeout(r, 50));
    // A short turn inside that pause.
    await amp.handlers["agent.start"]({ thread: { id: "T-race" }, message: "quick", id: "q" });
    await amp.handlers["agent.end"](turnEnd("T-race", "quick"));
    await new Promise((r) => setTimeout(r, 400));
    hub.add("arrived after the race");
    await until(() => amp.appended.length > 0, 5000);
    expect(amp.appended).toHaveLength(1);
    expect(amp.appended[0].message.content).toMatch(/arrived after the race/);
    amp.dispose();
  });

  it("S3: a notice Amp fails to append is not counted as told, and is tried again", async () => {
    const hub = fakeInbox();
    const { createPlugin } = await import("../examples/hooks/opencadre-amp-plugin.mjs") as { createPlugin: PluginFactory };
    const amp = fakeAmp(gitProject("AmpAppendFail"));
    let refusals = 1;
    const real = amp.api.threads.get;
    amp.api.threads.get = (thread: string) => ({
      appendUserMessage: async (m: { type: string; content: string }) => {
        if (refusals-- > 0) throw new Error("thread busy");
        return real(thread).appendUserMessage(m);
      },
    });
    createPlugin({ env: ampEnv(withCredential("oc-amp-append-")), fetchImpl: hub.fetchImpl, waitSeconds: 1, retryMs: 20 })(amp.api);
    await amp.handlers["agent.end"](turnEnd("T-busy"));
    hub.add("please retry me");
    await until(() => amp.appended.length > 0, 5000);
    expect(amp.appended).toHaveLength(1);
    expect(amp.appended[0].message.content).toMatch(/please retry me/);
    amp.dispose();
  });
});

describe("connect and Amp's own folder (review of 597af1c)", () => {
  it("S5: with XDG_CONFIG_HOME set, the server, the plugin and doctor all use $XDG_CONFIG_HOME/amp", async () => {
    const hub = await startHub();
    try {
      const { operatorKey } = await operatorWorkspace("Amp XDG Org");
      const { code } = await mintDevice(hub.url, operatorKey, "auto");
      const home = tempDir("oc-amp-xdg-");
      const xdg = path.join(home, "xdg");
      mkdirSync(path.join(xdg, "amp"), { recursive: true });
      writeFileSync(path.join(xdg, "amp", "settings.json"), "{}");
      const env = childEnv(home, { XDG_CONFIG_HOME: xdg });
      const r = await runNode(CLI, ["connect", "--hub", hub.url, "--code", code, "--home", home, "--client", "amp"], env);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(readFileSync(path.join(xdg, "amp", "settings.json"), "utf8"))["amp.mcpServers"]["opencadre-session"]).toBeDefined();
      expect(readFileSync(path.join(xdg, "amp", "plugins", "opencadre.js"), "utf8")).toContain("opencadre-amp-plugin.mjs");
      expect(stampActive({ client: "amp", home, env })).toBe(true);
      const doctor = await runNode(CLI, ["doctor", "--client", "amp", "--home", home], env);
      expect(doctor.out).toMatch(/hooks=present/);
    } finally {
      await hub.close();
    }
  }, 60_000);

  it("S4: Amp JSONC is preserved: named and Amp-only auto stop, multi-tool auto skips Amp", async () => {
    const hub = await startHub();
    try {
      const { operatorKey } = await operatorWorkspace("Amp JSONC Org");
      const home = tempDir("oc-amp-jsonc-");
      mkdirSync(path.join(home, ".config", "amp"), { recursive: true });
      const jsonc = '{\n  // my settings\n  "amp.notifications.enabled": true,\n}\n';
      writeFileSync(path.join(home, ".config", "amp", "settings.json"), jsonc);
      const ampOnly = await runNode(CLI, ["connect", "--hub", hub.url, "--code", (await mintDevice(hub.url, operatorKey, "auto")).code, "--home", home], ampEnv(home));
      expect(ampOnly.code).not.toBe(0);
      expect(ampOnly.err).toMatch(/holds comments or trailing commas/);
      expect(readFileSync(path.join(home, ".config", "amp", "settings.json"), "utf8")).toBe(jsonc);
      expect(existsSync(path.join(home, ".opencadre", "credentials.json"))).toBe(false);
      mkdirSync(path.join(home, ".cursor"));
      // Cursor detection requires a Cursor-owned marker; the folder alone may be created by OpenCadre.
      writeFileSync(path.join(home, ".cursor", "cli-config.json"), "{}");
      const named = await runNode(CLI, ["connect", "--hub", hub.url, "--code", (await mintDevice(hub.url, operatorKey, "auto")).code, "--home", home, "--client", "amp"], ampEnv(home));
      expect(named.code).not.toBe(0);
      expect(named.err).toMatch(/holds comments or trailing commas/);
      const auto = await runNode(CLI, ["connect", "--hub", hub.url, "--code", (await mintDevice(hub.url, operatorKey, "auto")).code, "--home", home], ampEnv(home));
      expect(auto.code, auto.err).toBe(0);
      expect(auto.out).toMatch(/Amp was not set up/);
      expect(readFileSync(path.join(home, ".config", "amp", "settings.json"), "utf8")).toBe(jsonc);
      expect(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["opencadre-session"]).toBeDefined();
    } finally {
      await hub.close();
    }
  }, 60_000);

  it("S7: the amp.rs editor's ~/.config/amp (no settings.json) is not Amp", async () => {
    const { detectClients } = await import("../cli/lib/clients.mjs");
    const home = tempDir("oc-amp-editor-");
    mkdirSync(path.join(home, ".config", "amp"), { recursive: true });
    writeFileSync(path.join(home, ".config", "amp", "config.yml"), "theme: dark\n");
    expect(detectClients(home, ampEnv(home))).not.toContain("amp");
    writeFileSync(path.join(home, ".config", "amp", "settings.json"), "{}");
    expect(detectClients(home, ampEnv(home))).toContain("amp");
  });
});
