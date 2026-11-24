// Kilo Code's CLI: the capabilities of LAUNCH-CLIENT-GATE.md §1, driven the way Kilo drives a plugin, with every shape
// MEASURED against the real 7.7.9 binary (docs/qa/HARNESS-MEASUREMENT.md §9; tests/kilo-live.test.ts runs it):
//   plugin(ctx)  ctx { client, project, worktree, directory, $, serverUrl, experimental_workspace } -> hooks
//   tool.execute.before(input { tool, sessionID, callID }, output { args })   a property set on output.args reaches the
//                call; a throw blocks it and the model reads the message. MCP tools are `<server>_<tool>`.
//   event({ event })   session.created/updated { sessionID, info: { parentID? } }, session.status { status: { type } },
//                session.idle { sessionID }
//   client.session.promptAsync({ path: { id }, body: { parts } })   starts a turn in an idle session
// The plugin under test is the copy `connect` installed into ~/.opencadre/bin, so the import rewrite is exercised too.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAMP_FIELD, stampActive, verifyStamp } from "../scripts/opencadre-config.mjs";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir, WORD_NAME,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

/** The environment Kilo and connect see: never a machine XDG_CONFIG_HOME, so the Kilo folder is the home's own. */
const kiloEnv = (home: string, extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", ...extra });

type Hooks = {
  "tool.execute.before": (input: object, output: { args: Record<string, unknown> }) => Promise<void>;
  event: (e: { event: { type: string; properties: object } }) => Promise<void>;
};
type Factory = (opts: object) => (ctx: object) => Promise<Hooks>;

/** A stand-in for Kilo's plugin context: the members the plugin uses, recording the turns it starts. */
function fakeKilo(project: string, parents: Record<string, string> = {}) {
  const prompted: Array<{ id: string; text: string }> = [];
  const ctx = {
    directory: project,
    worktree: project,
    client: {
      session: {
        promptAsync: async ({ path: p, body }: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => { prompted.push({ id: p.id, text: body.parts[0].text }); },
        get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id, parentID: parents[p.id] } }),
      },
    },
  };
  return { ctx, prompted };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("Kilo Code, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let credential: string;
  let bin: string;
  let hooks: Hooks;
  let kilo: ReturnType<typeof fakeKilo>;
  const project = gitProject("KiloProj");
  const proxies: ProxyProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Kilo Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:kiloproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-kilo-e2e-");
    // A user's own Kilo config: a plugin, an MCP server and a setting, which connect must keep.
    mkdirSync(path.join(home, ".config", "kilo"), { recursive: true });
    writeFileSync(path.join(home, ".config", "kilo", "kilo.json"), JSON.stringify({ model: "x/y", plugin: ["kilo-plugin-foo"], mcp: { linear: { type: "remote", url: "https://mcp.linear.app/mcp" } } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "kilo"], kiloEnv(home));
    expect(connected.code, connected.err).toBe(0);
    credential = computerCredential(home);
    bin = path.join(home, ".opencadre", "bin");
    // kilo-core is a LIBRARY: since Q1g PR-2 it lives only in the active generation (bin/.gen/<id>/), behind the entry stub.
    const gen = path.join(bin, ".gen", readFileSync(path.join(bin, ".gen", "current"), "utf8").trim());
    const { createKiloPlugin } = await import(pathToFileURL(path.join(gen, "opencadre-kilo-core.mjs")).href) as { createKiloPlugin: Factory };
    kilo = fakeKilo(project, { "ses_child": "ses_aaaa" });
    hooks = await createKiloPlugin({ env: { ...kiloEnv(home), ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" }, waitSeconds: 2, retryMs: 50 })(kilo.ctx);
  }, 60_000);

  afterAll(async () => {
    for (const id of ["ses_aaaa", "ses_bbbb"]) await hooks?.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } });
    await Promise.all(proxies.map((p) => p.close()));
    await hub.close();
  });

  const proxy = async () => {
    const p = new ProxyProcess(path.join(bin, "opencadre-mcp.mjs"), childEnv(home), project, "kilo");
    proxies.push(p);
    expect((await p.initialize()).error).toBeUndefined();
    return p;
  };
  /** What Kilo does around the hook: the SAME args object goes on to the call. */
  const asKiloWould = async (sessionID: string, tool: string, args: Record<string, unknown>) => {
    const output = { args: { ...args } };
    await hooks["tool.execute.before"]({ tool, sessionID, callID: `call-${Math.random()}` }, output);
    return output.args;
  };
  const event = (type: string, properties: object) => hooks.event({ event: { type, properties } });
  const promptedTo = (id: string) => kilo.prompted.filter((p) => p.id === id);

  it("connect wrote the server and the plugin into kilo.json, keeping the user's own, and the plugin file exports one function", async () => {
    const config = JSON.parse(readFileSync(path.join(home, ".config", "kilo", "kilo.json"), "utf8"));
    expect(config.model).toBe("x/y");
    expect(config.mcp.linear).toEqual({ type: "remote", url: "https://mcp.linear.app/mcp" });
    expect(config.mcp["opencadre-session"]).toEqual({ type: "local", command: ["node", path.join(bin, "opencadre-mcp.mjs"), "--client", "kilo"] });
    expect(config.plugin).toEqual(["kilo-plugin-foo", pathToFileURL(path.join(bin, "opencadre-kilo-plugin.js")).href]);
    // Kilo calls every exported function as a plugin: the file it loads exports exactly one.
    // Both the entry stub Kilo loads and the generation's module behind it (Q1g PR-2) export exactly one name.
    const plugin = readFileSync(path.join(bin, "opencadre-kilo-plugin.js"), "utf8");
    expect(plugin.match(/^export /gm)).toEqual(["export "]);
    const gen = path.join(bin, ".gen", readFileSync(path.join(bin, ".gen", "current"), "utf8").trim());
    const inGeneration = readFileSync(path.join(gen, "opencadre-kilo-plugin.js"), "utf8");
    expect(inGeneration.match(/^export /gm)).toEqual(["export "]);
    expect(inGeneration).toMatch(/from "\.\/opencadre-kilo-core\.mjs"/);
    expect(stampActive({ client: "kilo", home, env: kiloEnv(home) })).toBe(true);
    // A config existed, so Kilo's own migration marker is left to Kilo.
    expect(existsSync(path.join(home, ".config", "kilo", ".bash-permission-migrated"))).toBe(false);
    // Running connect again changes nothing.
    const again = await runNode(CLI, ["connect", "--home", home, "--client", "kilo"], kiloEnv(home));
    expect(again.code, again.err).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, ".config", "kilo", "kilo.json"), "utf8"))).toEqual(config);
  });

  it("starting Kilo mints NO agent, and an unstamped call is refused rather than pooled", async () => {
    const p = await proxy();
    const names = ((await p.request("tools/list", {})).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("set_status");
    const res = await p.request("tools/call", { name: "set_status", arguments: { task: "no stamp" } });
    expect(res.error?.message).toMatch(/no identity stamp.*Kilo plugin/);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("the plugin adds the session's stamp IN PLACE to OpenCadre's own calls, and to nothing else", async () => {
    const args = { task: "reviewing", files: ["a.ts"] };
    const { [STAMP_FIELD]: stamp, ...rest } = await asKiloWould("ses_aaaa", "opencadre-session_set_status", args);
    expect(rest).toEqual(args);
    expect(verifyStamp(credential, stamp)).toEqual({ ok: true, sessionId: "ses_aaaa" });
    expect(await asKiloWould("ses_aaaa", "linear_set_status", args)).toEqual(args);
    expect(await asKiloWould("ses_aaaa", "read", { filePath: "a.ts" })).toEqual({ filePath: "a.ts" });
  });

  it("two Kilo sessions are two agents, each call landing on its own", async () => {
    const p = await proxy();
    await p.callTool("set_status", await asKiloWould("ses_aaaa", "opencadre-session_set_status", { task: "session A at work" }));
    await p.callTool("set_status", await asKiloWould("ses_bbbb", "opencadre-session_set_status", { task: "session B at work" }));
    const rows = await liveSessions(hub.url, operatorKey, deviceId) as Array<{ agentName: string; tool: string | null; currentTask?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["kilo", "kilo"]);
    for (const r of rows) expect(r).toMatchObject({ agentName: expect.stringMatching(WORD_NAME), tool: "kilo", projectName: "KiloProj" });
    expect(rows.map((r) => r.currentTask).sort()).toEqual(["session A at work", "session B at work"]);
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

  it("MAIL: unread mail when a session goes idle starts ONE turn with the notice; the other session is left alone", async () => {
    await event("session.status", { sessionID: "ses_aaaa", status: { type: "busy" } });
    await send(await agentOf("session A at work"), "kilo, please look");
    await event("session.idle", { sessionID: "ses_aaaa" });
    expect(promptedTo("ses_aaaa")).toHaveLength(1);
    expect(promptedTo("ses_aaaa")[0].text).toMatch(/You have 1 unread OpenCadre message\(s\)[\s\S]*kilo, please look/);
    await event("session.idle", { sessionID: "ses_bbbb" });
    expect(promptedTo("ses_bbbb")).toEqual([]);
    // The prompted turn runs and ends without reading the mail: it is not announced twice.
    await event("session.status", { sessionID: "ses_aaaa", status: { type: "busy" } });
    await event("session.idle", { sessionID: "ses_aaaa" });
    await new Promise((r) => setTimeout(r, 300));
    expect(promptedTo("ses_aaaa")).toHaveLength(1);
  });

  it("IDLE WAKE: an idle session gets ONE prompt when new mail arrives, naming only the new mail", async () => {
    await send(await agentOf("session A at work"), "are you there, kilo?");
    await until(() => promptedTo("ses_aaaa").length > 1);
    expect(promptedTo("ses_aaaa")).toHaveLength(2);
    expect(promptedTo("ses_aaaa")[1].text).toMatch(/are you there, kilo\?/);
    expect(promptedTo("ses_aaaa")[1].text).not.toMatch(/please look/);
  });

  it("a busy session stops being watched, and hears its mail when it next goes idle", async () => {
    await event("session.status", { sessionID: "ses_bbbb", status: { type: "busy" } });
    await send(await agentOf("session B at work"), "for B, while busy");
    await new Promise((r) => setTimeout(r, 2500));
    expect(promptedTo("ses_bbbb")).toEqual([]);
    await event("session.idle", { sessionID: "ses_bbbb" });
    expect(promptedTo("ses_bbbb")[0].text).toMatch(/for B, while busy/);
  });

  it("a SUBAGENT's session is never prompted", async () => {
    await event("session.created", { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_aaaa" } });
    await event("session.idle", { sessionID: "ses_child" });
    // An id Kilo never announced is asked about: the fake says it has a parent too.
    await event("session.idle", { sessionID: "ses_child" });
    await new Promise((r) => setTimeout(r, 300));
    expect(promptedTo("ses_child")).toEqual([]);
  });

  it("CLEARANCE: a risky bash command is held, asked for as the session's agent, and a denial blocks the call with the reason", async () => {
    await event("session.status", { sessionID: "ses_aaaa", status: { type: "busy" } });
    const call = asKiloWould("ses_aaaa", "bash", { command: "rm -rf ./src", description: "clean" });
    const outcome = call.then(() => "ran", (e: Error) => e.message);
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    await until(() => (pending = listApprovals(orgId, { status: "pending" }) as typeof pending).length > 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Kilo Code wants to run this shell command in .*KiloProj/);
    expect(pending[0].requested_by_agent_name).toBe(await agentOf("session A at work"));
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect(await outcome).toMatch(/denied by Operator: no/);
    // A harmless command: no opinion, so Kilo's own permissions decide.
    expect(await asKiloWould("ses_aaaa", "bash", { command: "git status" })).toEqual({ command: "git status" });
  });

  it("a background process start is a shell command too", async () => {
    const call = asKiloWould("ses_aaaa", "background_process", { action: "start", command: "rm -rf ./lib" });
    const outcome = call.then(() => "ran", (e: Error) => e.message);
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; details: string }> = [];
    await until(() => (pending = listApprovals(orgId, { status: "pending" }) as typeof pending).length > 0);
    expect(pending[0].details).toMatch(/^Kilo Code wants to run this shell command/);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not that either" });
    expect(await outcome).toMatch(/denied by Operator: not that either/);
    expect(await asKiloWould("ses_aaaa", "background_process", { action: "list" })).toEqual({ action: "list" });
  });

  it("doctor --client kilo finds the server and the plugin, and says so when the plugin entry is gone", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "kilo", "--home", home], kiloEnv(home));
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
    const file = path.join(home, ".config", "kilo", "kilo.json");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(text), plugin: ["kilo-plugin-foo"] }));
    try {
      const gone = await runNode(CLI, ["doctor", "--client", "kilo", "--home", home], kiloEnv(home));
      expect(gone.out).toMatch(/hooks=missing/);
      expect(stampActive({ client: "kilo", home, env: kiloEnv(home) })).toBe(false);
    } finally {
      writeFileSync(file, text);
    }
  });
});

describe("connect for Kilo on a machine where Kilo has no config yet", () => {
  it("writes Kilo's migration marker too, so a new user is not migrated to allowing every bash command", async () => {
    const home = tempDir("oc-kilo-fresh-");
    const { planKiloConfig } = await import("../cli/lib/device.mjs") as { planKiloConfig: (o: object) => { file: string; after: string; marker: string | null } };
    const env = { XDG_CONFIG_HOME: "" };
    const fresh = planKiloConfig({ home, proxyPath: "/b/opencadre-mcp.mjs", pluginPath: "/b/opencadre-kilo-plugin.js", env });
    expect(fresh.marker).toBe(path.join(home, ".config", "kilo", ".bash-permission-migrated"));
    // Any config Kilo already had (or its own marker) means Kilo decides for itself.
    mkdirSync(path.join(home, ".config", "kilo"), { recursive: true });
    writeFileSync(path.join(home, ".config", "kilo", "opencode.json"), "{}");
    expect(planKiloConfig({ home, proxyPath: "/b/opencadre-mcp.mjs", pluginPath: "/b/opencadre-kilo-plugin.js", env }).marker).toBeNull();
    rmSync(path.join(home, ".config", "kilo", "opencode.json"));
    writeFileSync(path.join(home, ".config", "kilo", ".bash-permission-migrated"), "");
    expect(planKiloConfig({ home, proxyPath: "/b/opencadre-mcp.mjs", pluginPath: "/b/opencadre-kilo-plugin.js", env }).marker).toBeNull();
  });

  it("a kilo.json with comments is refused by name, with the entries to add by hand", async () => {
    const home = tempDir("oc-kilo-jsonc-");
    mkdirSync(path.join(home, ".config", "kilo"), { recursive: true });
    writeFileSync(path.join(home, ".config", "kilo", "kilo.json"), "{\n  // mine\n  \"model\": \"x/y\",\n}\n");
    const r = await runNode(CLI, ["connect", "--hub", "http://127.0.0.1:9", "--code", "ocd_ZZZZZZZZZZ", "--home", home, "--client", "kilo"], kiloEnv(home));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/kilo\.json holds comments or trailing commas \(Kilo reads it as JSONC\)/);
    expect(readFileSync(path.join(home, ".config", "kilo", "kilo.json"), "utf8")).toContain("// mine");
  });
});

describe("the Kilo plugin when it cannot ask", () => {
  it("a gate that cannot run BLOCKS the command: Kilo awaits the hook, and a failed clearance is never a pass", async () => {
    const { createKiloPlugin } = await import("../examples/hooks/opencadre-kilo-core.mjs") as { createKiloPlugin: Factory };
    const spawnImpl = () => { throw new Error("no node"); };
    const hooks = await createKiloPlugin({ env: {}, spawnImpl })(fakeKilo(gitProject("KiloNoGate")).ctx);
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "ls" } })).rejects.toThrow(/approval gate could not run/);
  });

  it("says so when node is missing from Kilo's PATH (Kilo runs under Bun; the gate needs Node)", async () => {
    const { createKiloPlugin } = await import("../examples/hooks/opencadre-kilo-core.mjs") as { createKiloPlugin: Factory };
    const spawnImpl = () => { throw Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }); };
    const hooks = await createKiloPlugin({ env: {}, spawnImpl })(fakeKilo(gitProject("KiloNoNode")).ctx);
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "ls" } })).rejects.toThrow(/`node` is not on this Kilo's PATH/);
  });

  it("a kilo.json that only MENTIONS the plugin (not in `plugin`) is not the plugin installed", async () => {
    const home = tempDir("oc-kilo-mention-");
    mkdirSync(path.join(home, ".config", "kilo"), { recursive: true });
    writeFileSync(path.join(home, ".config", "kilo", "kilo.json"), JSON.stringify({ note: "removed opencadre-kilo-plugin.js", plugin: [] }));
    expect(stampActive({ client: "kilo", home, env: kiloEnv(home) })).toBe(false);
  });

  it("an event it cannot read, or a hub it cannot reach, never throws into Kilo", async () => {
    const { createKiloPlugin } = await import("../examples/hooks/opencadre-kilo-core.mjs") as { createKiloPlugin: Factory };
    const home = tempDir("oc-kilo-down-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://hub.invalid", credential: `dev_${"0".repeat(48)}`, deviceId: "d" } }));
    const fetchImpl = async () => { throw new Error("offline"); };
    const kilo = fakeKilo(gitProject("KiloDown"));
    const hooks = await createKiloPlugin({ env: childEnv(home), fetchImpl, waitSeconds: 1, retryMs: 10 })(kilo.ctx);
    await hooks.event({ event: { type: "session.idle", properties: {} } });
    await hooks.event(undefined as never);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } });
    expect(kilo.prompted).toEqual([]);
  });
});
