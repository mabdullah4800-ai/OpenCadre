import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";

/** scripts/opencadre-mcp.mjs: every Claude Code session on a connected machine is its own agent (docs/design/SESSION_MODEL.md). */

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

let hub: Awaited<ReturnType<typeof startHub>>;
let operatorKey: string;
let deviceId: string;
let home: string;
let credential: string;
let proxyScript: string;
const proxies: ProxyProcess[] = [];

/** Every byte any proxy printed, for the credential check at the end. */
const allOutput = () => proxies.map((p) => p.out + p.err).join("\n");

function startProxy(env: Record<string, string>, cwd: string, proxyHome = home) {
  const proxy = new ProxyProcess(proxyScript, childEnv(proxyHome, env), cwd);
  proxies.push(proxy);
  return proxy;
}

/** A new chat's name is one word (sessions PR1), or on collision two words or a word and a number. The client and
 * project it used to spell out ("ClaudeCode-ProxyProj-1a2b") are the session's `tool` and `projectName`, and the roster
 * line's "(ClaudeCode in ProxyProj)". */
const SESSION_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+| \d+)?$/;
const PROXY_PROJ_SESSION = { tool: "claude-code", projectName: "ProxyProj" };

/**
 * The full row GET /v1/org/sessions returns (src/devices.ts SessionView). The helper's own
 * `SessionView` names only the six fields its other callers read, so the fields the #16116 tripwire
 * has to reason over — `currentTask` above all — are not on it.
 */
type SessionRow = {
  agentId: string;
  agentName: string;
  project: string | null;
  projectKey: string | null;
  projectName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  client: string | null;
  tool: string | null;
  online: boolean;
  currentTask: string | null;
  /** #16116's label: 'chat' once the session served a tool call, 'process' before that, null if the
   * row predates migration 38. Named here so the tripwire below reads as a carrier, not a spread. */
  liveness: string | null;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

beforeAll(async () => {
  hub = await startHub();
  ({ operatorKey } = await operatorWorkspace("Proxy Org"));
  // local:proxyprojbad too: the proxy now checks the enabled-project list before anything else, and an unlisted folder
  // gets the quiet not-enabled server, so the unusable-id case needs an enabled folder to reach its own error.
  for (const project of ["local:proxyproj", "local:namedproj", "local:proxyprojbad"]) await enableProject(hub.url, operatorKey, project);
  const minted = await mintDevice(hub.url, operatorKey);
  deviceId = minted.deviceId;
  home = tempDir("oc-proxy-home-");
  // Machine connect from a plain terminal (no session ids): it installs the proxy and writes the credential.
  const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"], childEnv(home));
  expect(connected.err).toBe("");
  expect(connected.code).toBe(0);
  credential = computerCredential(home);
  expect(credential).toMatch(/^dev_[0-9a-f]{48}$/);
  proxyScript = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
}, 60_000);

afterAll(async () => {
  await Promise.all(proxies.map((p) => p.close()));
  await hub.close();
});

describe("opencadre-mcp.mjs: one agent per Claude Code session", () => {
  const project = gitProject("ProxyProj");
  let nameA = "";
  let nameB = "";
  let proxyA: ProxyProcess;
  let proxyB: ProxyProcess;

  it("relays initialize, notifications, tools/list and tool calls as this session's own agent", async () => {
    mkdirSync(path.join(project, "src"), { recursive: true });
    // Started in a subfolder: the name comes from the git root.
    proxyA = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-A", CLAUDE_CODE_HOST_SESSION_ID: "host-H1" }, path.join(project, "src"));
    const init = await proxyA.initialize();
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo.name).toBe("opencadre");
    proxyA.notify("notifications/initialized");

    const tools = await proxyA.request("tools/list");
    const names = (tools.result.tools as Array<{ name: string }>).map((t) => t.name);
    for (const t of ["get_active_agents", "send_message", "get_messages", "wait_for_message"]) expect(names).toContain(t);
    // A notification gets no answer: only the two requests have produced output so far.
    expect(proxyA.messages).toHaveLength(2);

    const sessions = await liveSessions(hub.url, operatorKey, deviceId);
    expect(sessions).toHaveLength(1);
    nameA = sessions[0].agentName;
    expect(nameA).toMatch(SESSION_NAME);
    expect(sessions[0]).toMatchObject(PROXY_PROJ_SESSION);
    expect(await proxyA.callTool("get_active_agents")).toContain(`${nameA} (ClaudeCode in ProxyProj) — `);
  }, 30_000);

  it("two sessions with different host ids are two agents, and mail from one reaches the other by name", async () => {
    proxyB = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-B", CLAUDE_CODE_HOST_SESSION_ID: "host-H2" }, project);
    await proxyB.initialize();
    const sessions = await liveSessions(hub.url, operatorKey, deviceId);
    expect(sessions).toHaveLength(2);
    nameB = sessions.map((s) => s.agentName).find((n) => n !== nameA)!;
    expect(nameB).toMatch(SESSION_NAME);
    expect(sessions.find((s) => s.agentName === nameB)).toMatchObject(PROXY_PROJ_SESSION);

    expect(await proxyA.callTool("send_message", { toAgent: nameB, body: "hello from session A" })).toContain(`Message sent to ${nameB}`);
    const inbox = await proxyB.callTool("get_messages");
    expect(inbox).toContain("hello from session A");
    expect(inbox).toContain(nameA);
  }, 30_000);

  it("a new tool session on the same host session (after /clear) is the same agent", async () => {
    const cleared = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-A-after-clear", CLAUDE_CODE_HOST_SESSION_ID: "host-H1" }, project);
    await cleared.initialize();
    await cleared.callTool("send_message", { toAgent: nameB, body: "still me after clear" });
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(2);
    const inbox = await proxyB.callTool("get_messages");
    expect(inbox).toContain("still me after clear");
    expect(inbox).toContain(nameA);
  }, 30_000);

  it("runs requests concurrently: a held wait_for_message never blocks a later call", async () => {
    const waitId = 9001;
    proxyA.write({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "wait_for_message", arguments: { timeoutSeconds: 4 } } });
    const started = Date.now();
    const list = await proxyA.request("tools/list");
    expect(list.result.tools.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(proxyA.messages.find((m) => m.id === waitId)).toBeUndefined();
    const waited = await proxyA.response(waitId, 15_000);
    expect(waited.error).toBeUndefined();
  }, 30_000);

  it("re-creates its hub session when the hub forgets it (a deploy, or the 30-minute idle sweep), as the same agent", async () => {
    // Before this fix every later call answered "MCP session not found or expired (HTTP 404)" until the
    // client itself was restarted: every chat on a machine went deaf after a hub deploy (2026-09-18).
    const { sweepIdleMcpSessions } = await import("../src/mcp.js");
    const agentsBefore = (await liveSessions(hub.url, operatorKey, deviceId)).map((s) => s.agentName).sort();
    expect(await proxyA.callTool("get_active_agents")).toContain(nameA);

    // What a hub restart does to the in-memory MCP sessions: every one of them is gone.
    expect(sweepIdleMcpSessions(Date.now() + 31 * 60 * 1000)).toBeGreaterThan(0);

    expect(await proxyA.callTool("get_active_agents")).toContain(nameA);
    expect(await proxyA.callTool("send_message", { toAgent: nameB, body: "still here after the hub forgot me" })).toContain(`Message sent to ${nameB}`);
    // Same identity, not a new agent: re-initializing reuses this session's own id headers.
    expect((await liveSessions(hub.url, operatorKey, deviceId)).map((s) => s.agentName).sort()).toEqual(agentsBefore);
    expect(proxyA.err).toContain("re-initialized");
  }, 30_000);

  it("reopens one hub session for concurrent calls after expiry", async () => {
    const { sweepIdleMcpSessions } = await import("../src/mcp.js");
    const recovery = startProxy({ CLAUDE_CODE_SESSION_ID: "concurrent-recovery", CLAUDE_CODE_HOST_SESSION_ID: "host-concurrent-recovery" }, project);
    await recovery.initialize();
    expect(await recovery.callTool("get_active_agents")).toContain(" (ClaudeCode in ProxyProj) — ");
    const before = (recovery.err.match(/re-initialized/g) ?? []).length;
    expect(sweepIdleMcpSessions(Date.now() + 31 * 60 * 1000)).toBeGreaterThan(0);

    const ids = Array.from({ length: 8 }, (_, index) => 10_000 + index);
    for (const id of ids) recovery.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_active_agents", arguments: {} } });
    const replies = await Promise.all(ids.map((id) => recovery.response(id)));
    for (const reply of replies) {
      expect(reply.error).toBeUndefined();
      expect(JSON.stringify(reply.result)).toContain(" (ClaudeCode in ProxyProj) — ");
    }
    expect((recovery.err.match(/re-initialized/g) ?? []).length - before).toBe(1);
  }, 30_000);

  // Sprint lane 3, job 1: "two Claude Code chats in one folder must be two agents."
  //
  // The tests above cover two agents in DIFFERENT folders (a subfolder and the repo root), and they
  // set CLAUDE_CODE_HOST_SESSION_ID explicitly. Neither matches a real pair of chats, which:
  //   (a) share ONE working folder, and
  //   (b) have NO host session id — measured on this PC: CLAUDE_CODE_SESSION_ID is set, HOST is unset.
  //
  // (b) is the case that matters for identity, because the hub resolves the seat as
  // `hostSessionId || toolSessionId` (src/devices.ts:434). With no host id the seat falls back to the
  // tool session id, so two chats are still two seats — but that is exactly the fallback nobody had
  // asserted, and it is the one a real chat takes. The failure this test would catch is two real chats
  // sharing one seat (one agent answering for both), not an error.
  it("two chats in ONE folder with no host session id are two agents, and each keeps its own inbox", async () => {
    const shared = gitProject("ProxyProj");
    // Both proxies start in the SAME folder, and neither sets a host id — the real chat shape.
    const chatOne = startProxy({ CLAUDE_CODE_SESSION_ID: "chat-one-tool-id" }, shared);
    const chatTwo = startProxy({ CLAUDE_CODE_SESSION_ID: "chat-two-tool-id" }, shared);
    // Identify the two chats by SET DIFFERENCE, not by order and not from a tool's output:
    // /v1/org/sessions makes no ordering promise, and get_active_agents returns the whole roster
    // (including agents from earlier tests), so neither can say which name belongs to which chat.
    const namesBefore = new Set((await liveSessions(hub.url, operatorKey, deviceId)).map((s) => s.agentName));
    await chatOne.initialize();
    await chatOne.notify("notifications/initialized");
    const afterFirst = (await liveSessions(hub.url, operatorKey, deviceId)).map((s) => s.agentName);
    await chatTwo.initialize();
    await chatTwo.notify("notifications/initialized");

    const sessions = await liveSessions(hub.url, operatorKey, deviceId);
    // Two more sessions, not one: sharing a folder must not collapse them.
    expect(sessions).toHaveLength(namesBefore.size + 2);
    expect(afterFirst).toHaveLength(namesBefore.size + 1);

    // chatOne is whichever name appeared first, chatTwo the other. Each chat must then answer as
    // ITSELF — the property a shared seat would break.
    const nameOne = afterFirst.find((n) => !namesBefore.has(n))!;
    const nameTwo = sessions.map((s) => s.agentName).find((n) => !namesBefore.has(n) && n !== nameOne)!;
    expect(nameOne).not.toBe(nameTwo);
    expect(nameOne).toMatch(SESSION_NAME);
    expect(nameTwo).toMatch(SESSION_NAME);
    for (const n of [nameOne, nameTwo]) expect(sessions.find((s) => s.agentName === n)).toMatchObject(PROXY_PROJ_SESSION);

    // Mail sent to chat two is readable by chat two and NOT by chat one. A shared seat would put it
    // in one inbox and make the other unable to answer at all.
    expect(await chatOne.callTool("send_message", { toAgent: nameTwo, body: "to chat two only" })).toContain(`Message sent to ${nameTwo}`);
    expect(await chatTwo.callTool("get_messages")).toContain("to chat two only");
    expect(await chatOne.callTool("get_messages")).not.toContain("to chat two only");

    await chatOne.close();
    await chatTwo.close();
  }, 30_000);

  it("a chat with no host id and a chat WITH one are still two agents in the same folder", async () => {
    // Mixed shape: one real chat (no host id) beside one that sets it. Neither should take the other's
    // seat — this is the boundary between the two seat-resolution branches.
    const shared = gitProject("ProxyProj");
    const plain = startProxy({ CLAUDE_CODE_SESSION_ID: "mixed-plain-tool" }, shared);
    const keeper = startProxy({ CLAUDE_CODE_SESSION_ID: "mixed-keeper-tool", CLAUDE_CODE_HOST_SESSION_ID: "mixed-host" }, shared);
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;

    await plain.initialize();
    await plain.notify("notifications/initialized");
    await keeper.initialize();
    await keeper.notify("notifications/initialized");

    const sessions = await liveSessions(hub.url, operatorKey, deviceId);
    expect(sessions).toHaveLength(before + 2);
    expect(new Set(sessions.slice(-2).map((s) => s.agentName)).size).toBe(2);

    await plain.close();
    await keeper.close();
  }, 30_000);
});

describe("opencadre-mcp.mjs: fails closed", () => {
  // The two refusal messages are NUNT's (docs/design/UI_IDENTITY_FAILURES.md 3a/3b). These
  // patterns are chosen to be MUTUALLY EXCLUSIVE, and that is not fussiness: both messages end
  // "...so it has no identity", so the obvious discriminator /has no id/ matches BOTH - it is a
  // substring of "has no identity". Asserting it for absent and negating it for indeterminate would
  // have made one of the two assertions vacuous while looking rigorous. Each pattern below is a
  // phrase that appears in exactly one of the two strings.
  const ABSENT_ONLY = /this session has no id/;
  const INDETERMINATE_ONLY = /is not usable/;

  it("with no session id for this client: a JSON-RPC error, and no agent is created", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;
    const proxy = startProxy({ CLAUDE_CODE_HOST_SESSION_ID: "host-H3" }, gitProject("ProxyProj"));
    const init = await proxy.initialize();
    expect(init.result).toBeUndefined();
    // The client is Claude Code and its variable is unset, so this is the ABSENT case, and the
    // message says so rather than lumping it in with a malformed value.
    expect(init.error!.message).toMatch(ABSENT_ONLY);
    expect(init.error!.message).not.toMatch(INDETERMINATE_ONLY);
    // The action must precede the diagnosis, which was the real defect in the old wording: it
    // offered a speculative upgrade first and buried the remedy that actually works.
    expect(init.error!.message).toMatch(/Connect a named agent for this project instead/);
    const agentAt = init.error!.message.indexOf("Connect a named agent");
    const diagnosisAt = init.error!.message.indexOf("(Claude Code normally supplies one");
    expect(agentAt).toBeGreaterThan(-1);
    expect(diagnosisAt).toBeGreaterThan(agentAt);
    const list = await proxy.request("tools/list");
    expect(list.error!.message).toMatch(ABSENT_ONLY);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before);
  }, 30_000);

  it("with a session id that is set but unusable: a distinct error, and no agent is created", async () => {
    // Set-but-malformed and absent are different situations and must not collapse into one
    // message: this one is a value the user can see and fix. The hub's own rule is printable
    // ASCII with no spaces, so a space is enough to make an id unusable.
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;
    const proxy = startProxy(
      { CLAUDE_CODE_SESSION_ID: "not a valid session id", CLAUDE_CODE_HOST_SESSION_ID: "host-H4" },
      gitProject("ProxyProjBad"),
    );
    const init = await proxy.initialize();
    expect(init.result).toBeUndefined();
    expect(init.error!.message).toMatch(INDETERMINATE_ONLY);
    expect(init.error!.message).not.toMatch(ABSENT_ONLY);
    // It must say the value WAS SET - that is what tells the user to look at a value rather than
    // at their harness, and it is the whole reason this string exists separately.
    expect(init.error!.message).toMatch(/It was set but is not a valid id/);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before);
  }, 30_000);

  it("with a named agent configured for the folder: initialize succeeds, no tools, no session agent", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;
    const namedHome = tempDir("oc-proxy-named-");
    mkdirSync(path.join(namedHome, ".opencadre"), { recursive: true });
    writeFileSync(path.join(namedHome, ".opencadre", "credentials.json"), readFileSync(path.join(home, ".opencadre", "credentials.json")));
    const folder = gitProject("NamedProj");
    writeFileSync(path.join(namedHome, ".claude.json"), JSON.stringify({
      projects: { [folder]: { mcpServers: { opencadre: { type: "http", url: `${hub.url}/mcp`, headers: { Authorization: `Bearer agt_${"1".repeat(48)}` } } } } },
    }));
    const proxy = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-N", CLAUDE_CODE_HOST_SESSION_ID: "host-N" }, folder, namedHome);
    const init = await proxy.initialize();
    expect(init.error).toBeUndefined();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    proxy.notify("notifications/initialized");
    expect((await proxy.request("tools/list")).result).toEqual({ tools: [] });
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before);

    // The same home in a folder without a named agent: the session's own identity applies again.
    const elsewhere = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-N2", CLAUDE_CODE_HOST_SESSION_ID: "host-N2" }, gitProject("ProxyProj"), namedHome);
    expect((await elsewhere.request("tools/list")).result.tools.length).toBeGreaterThan(0);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before + 1);
  }, 30_000);

  it("with no device credential: a JSON-RPC error saying how to connect", async () => {
    const proxy = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-X", CLAUDE_CODE_HOST_SESSION_ID: "host-X" }, gitProject("ProxyProj"), tempDir("oc-proxy-empty-"));
    const init = await proxy.initialize();
    expect(init.error!.message).toBe("OpenCadre isn't connected on this machine: run the connect command from the console.");
  }, 30_000);

  it("a hub error becomes a JSON-RPC error with the hub's message, never the credential", async () => {
    const badHome = tempDir("oc-proxy-bad-");
    const fake = `dev_${"9".repeat(48)}`;
    mkdirSync(path.join(badHome, ".opencadre"), { recursive: true });
    writeFileSync(path.join(badHome, ".opencadre", "credentials.json"), JSON.stringify({ devices: { "claude-code": { hub: hub.url, credential: fake, deviceId: "nope" } } }));
    const proxy = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-Y", CLAUDE_CODE_HOST_SESSION_ID: "host-Y" }, gitProject("ProxyProj"), badHome);
    const init = await proxy.initialize();
    expect(init.error!.message).toBe("OpenCadre hub: invalid device credential or session (HTTP 401)");
    expect(proxy.out + proxy.err).not.toContain(fake);
  }, 30_000);
});

describe("machine connect from inside a chat", () => {
  it("the connect-time join and a later proxy with the same host session id are the same agent", async () => {
    const minted = await mintDevice(hub.url, operatorKey);
    const chatHome = tempDir("oc-proxy-chat-");
    const folder = gitProject("ChatProj");
    const chat = { CLAUDE_CODE_SESSION_ID: "tool-before-restart", CLAUDE_CODE_HOST_SESSION_ID: "desktop-chat-7" };
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", chatHome, "--client", "claude-code"], childEnv(chatHome, chat), folder);
    expect(connected.err).toBe("");
    expect(connected.code).toBe(0);
    const [joined] = await liveSessions(hub.url, operatorKey, minted.deviceId);
    expect(joined.agentName).toMatch(SESSION_NAME);
    expect(joined).toMatchObject({ tool: "claude-code", projectName: "ChatProj" });
    expect(connected.out).toContain(`This chat is now ${joined.agentName}. It works right away through the opencadre commands (inbox, reply, send, status, wait).`);

    // The restarted chat: a new tool session id, the same host session id.
    const restarted = new ProxyProcess(path.join(chatHome, ".opencadre", "bin", "opencadre-mcp.mjs"), childEnv(chatHome, { CLAUDE_CODE_SESSION_ID: "tool-after-restart", CLAUDE_CODE_HOST_SESSION_ID: "desktop-chat-7" }), folder);
    proxies.push(restarted);
    await restarted.initialize();
    expect(await restarted.callTool("get_active_agents")).toContain(joined.agentName);
    const after = await liveSessions(hub.url, operatorKey, minted.deviceId);
    expect(after).toHaveLength(1);
    expect(after[0].agentId).toBe(joined.agentId);
    // Connect run from that chat enabled its project, and only that one.
    expect(connected.out).toContain("Enabled this project: ChatProj. Other projects on this computer stay off until you enable them in the console.");
  }, 60_000);
});

describe("opencadre-mcp.mjs: projects are opt-in", () => {
  it("in a project the workspace hasn't enabled: an empty server that prints nothing and creates nothing", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;
    const folder = gitProject("OffProj");
    const proxy = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-off", CLAUDE_CODE_HOST_SESSION_ID: "host-off" }, folder);
    const init = await proxy.initialize();
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, instructions: "OpenCadre isn't enabled for this project." });
    proxy.notify("notifications/initialized");
    expect((await proxy.request("tools/list")).result).toEqual({ tools: [] });
    expect((await proxy.request("ping")).result).toEqual({});
    expect((await proxy.request("tools/call", { name: "get_messages", arguments: {} })).error!.code).toBe(-32601);
    expect(proxy.err).toBe("");
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before);

    // Once an operator enables it, a new chat there joins as usual.
    await enableProject(hub.url, operatorKey, "local:offproj");
    const later = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-on", CLAUDE_CODE_HOST_SESSION_ID: "host-on" }, folder);
    await later.initialize();
    expect((await later.request("tools/list")).result.tools.length).toBeGreaterThan(0);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before + 1);
  }, 30_000);

  it("names the project by its git remote: two checkouts of one repo in differently named folders are one project", async () => {
    await enableProject(hub.url, operatorKey, "github.com/acme/rocket");
    const first = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-r1", CLAUDE_CODE_HOST_SESSION_ID: "host-r1" }, gitProject("rocket-main", "git@github.com:Acme/Rocket.git"));
    const second = startProxy({ CLAUDE_CODE_SESSION_ID: "tool-r2", CLAUDE_CODE_HOST_SESSION_ID: "host-r2" }, gitProject("rocket-copy-2", "https://github.com/acme/rocket"));
    await first.initialize();
    await second.initialize();
    const rocket = (await liveSessions(hub.url, operatorKey, deviceId)).filter((s) => s.projectKey === "github.com/acme/rocket");
    expect(rocket).toHaveLength(2);
    // Each chat keeps the display name its own checkout gave the project; the names are words, not the project.
    for (const s of rocket) expect(s.agentName).toMatch(SESSION_NAME);
    expect(rocket.map((s) => s.projectName).sort()).toEqual(["Rocket", "rocket"]);
  }, 30_000);
});

describe("opencadre-mcp.mjs --client codex: one session per process", () => {
  it("each Codex chat's process makes up its own session, so two processes are two agents, and one process stays one", async () => {
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    const codexHome = tempDir("oc-proxy-codex-");
    mkdirSync(path.join(codexHome, ".codex"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", codexHome, "--client", "codex"], childEnv(codexHome));
    expect(connected.err).toBe("");
    expect(connected.code).toBe(0);
    const folder = gitProject("ProxyProj");
    const script = path.join(codexHome, ".opencadre", "bin", "opencadre-mcp.mjs");
    const chats = [0, 1].map(() => {
      // Codex sets no session id; even one inherited from elsewhere is ignored for Codex.
      const p = new ProxyProcess(script, childEnv(codexHome, { CLAUDE_CODE_SESSION_ID: "not-codex" }), folder, "codex");
      proxies.push(p);
      return p;
    });
    for (const chat of chats) {
      await chat.initialize();
      await chat.callTool("set_status", { task: "codex chat" });
      await chat.callTool("get_active_agents");
    }
    const sessions = await liveSessions(hub.url, operatorKey, minted.deviceId);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => SESSION_NAME.test(s.agentName) && s.tool === "codex" && s.projectName === "ProxyProj")).toBe(true);
    expect(allOutput()).not.toContain(computerCredential(codexHome));
  }, 60_000);

  // THE GATE'S CONTRACT — TWO HALVES THAT POINT OPPOSITE WAYS. Read both before "fixing" either:
  // the pair is only correct together, and the first half is the one that was wrong for a week.
  //
  // Ruling #16116 repealed the rule this block used to assert. It chose §4 option 2 of
  // docs/design/MCP-PROXY-CREATION-GATE.md: a client whose only creator is the proxy STILL creates a
  // session at `initialize`. The row is not suppressed — it is created "with its scope LABELLED", so
  // the console and later tooling can tell an app-start row from a chat-backed one. Measured 5.2A is
  // still the problem being solved: the Codex desktop app starts the MCP server several times per
  // app start with ZERO chats open, and each launch that reaches `initialize` mints a fresh identity.
  //
  // WHAT WAS HERE, and why it could never fire. The old test was
  // `it.fails("an initialize with no chat behind it must not put an agent on the roster")` asserting
  // `toEqual([])`. Measured at origin/main d63f08f, flipping `.fails` off printed
  // `expected [ 'Codex-ProxyProj-6179' ] to deeply equal []` — a chatless initialize really does
  // create a row, so that assertion throws before the gate lands AND after it lands, and `it.fails`
  // passes forever. It enforced the repealed rule, and worse, it would have reported the gate's
  // correct behaviour as a regression: the next lane to implement #16116 would have found a green
  // test insisting the roster be empty. Found independently by 1101 and 7570 (task e251a69c). The
  // shape of the mistake is worth keeping: the assertion named the OLD contract, so no implementation
  // of the NEW one could ever turn it red. A tripwire must assert the thing that is still TO COME.
  //
  // So the two halves below assert the NEW contract from both sides:
  //   - the row IS created, with the gate-invariant facts about it (a plain `it`) — this is the live
  //     rule, and it goes red only if someone implements the old no-row contract;
  //   - the row is NOT YET labelled (an `it.fails`) — the tripwire, which goes red the day a carrier
  //     for the label lands.

  it("MEASURED: a chatless initialize DOES put a row on the roster — ruling #16116, not the old rule", async () => {
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    const codexHome = tempDir("oc-proxy-codex-");
    mkdirSync(path.join(codexHome, ".codex"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", codexHome, "--client", "codex"], childEnv(codexHome));
    expect(connected.code).toBe(0);
    const folder = gitProject("ProxyProj");
    const script = path.join(codexHome, ".opencadre", "bin", "opencadre-mcp.mjs");

    // A launch that completes the MCP handshake and then sends nothing else — a chatless spawn.
    const idle = new ProxyProcess(script, childEnv(codexHome), folder, "codex");
    proxies.push(idle);
    await idle.initialize();
    await idle.notify("notifications/initialized");

    // Asserted as the full name list, not a length: if this ever fails it names what the roster
    // actually held, which is the evidence. A bare count would not say.
    const rows = await liveSessions(hub.url, operatorKey, minted.deviceId);
    const roster = rows.map((s) => s.agentName);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatch(SESSION_NAME);
    expect(rows[0]).toMatchObject({ tool: "codex", projectName: "ProxyProj" });
    await idle.close();
  }, 60_000);

  // The gate must add a label WITHOUT changing any of this. Asserted separately from the tripwire
  // below on purpose: `it.fails` passes when its body throws for ANY reason, so a precondition that
  // rots inside it would hide itself — which is the exact failure this pair exists to stop. These
  // facts live in a plain `it`, where rot is loud.
  it("a chatless and a chat-backed row differ only in ways the gate is not allowed to touch", async () => {
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    const codexHome = tempDir("oc-proxy-codex-");
    mkdirSync(path.join(codexHome, ".codex"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", codexHome, "--client", "codex"], childEnv(codexHome));
    expect(connected.code).toBe(0);
    const folder = gitProject("ProxyProj");
    const script = path.join(codexHome, ".opencadre", "bin", "opencadre-mcp.mjs");

    const idle = new ProxyProcess(script, childEnv(codexHome), folder, "codex");
    proxies.push(idle);
    await idle.initialize();
    await idle.notify("notifications/initialized");

    const chat = new ProxyProcess(script, childEnv(codexHome), folder, "codex");
    proxies.push(chat);
    await chat.initialize();
    await chat.callTool("set_status", { task: "chat-backed" });
    await chat.callTool("get_active_agents");

    const rows = (await liveSessions(hub.url, operatorKey, minted.deviceId)) as SessionRow[];
    expect(rows).toHaveLength(2);
    // Identity discipline without guesswork: the app-start row is the one nothing has set a task on.
    expect(rows.filter((s) => s.currentTask === null)).toHaveLength(1);
    expect(rows.filter((s) => s.currentTask !== null)).toHaveLength(1);
    // Same device, same folder, same client — the label is the only thing that may distinguish them.
    const same = (key: keyof SessionRow) => new Set(rows.map((s) => JSON.stringify(s[key]))).size === 1;
    for (const key of ["deviceId", "deviceName", "client", "tool", "project", "projectKey", "projectName", "online", "endedAt"] as const) {
      expect(same(key), `${key} must not depend on whether a chat is behind the row`).toBe(true);
    }
    await idle.close();
    await chat.close();
  }, 60_000);

  // THE TRIPWIRE, FIRED. It was `it.fails` until migration 38 landed, and it went red on the run that
  // added the carrier — which is the signal it was written to give, and which the `toEqual([])` above
  // could never be. Its own instruction was "remove `.fails`, keep the assertion, and say in the commit
  // which carrier landed": the carrier is **`agents.liveness`**, exposed as `liveness` on
  // GET /v1/org/sessions (migration 38), `'process'` at mint and promoted to `'chat'` on the first
  // `tools/call` the proxy observes.
  //
  // Carrier-agnostic by construction, and kept that way. #16116 says the scope is "LABELLED" but names
  // no field, so this asserts the PROPERTY rather than a field name: a label is "what lets the console
  // and later tooling tell a chat-backed row from an app-start row". Any carrier satisfies that by
  // making the two rows distinguishable in the payload the console already reads, and none can satisfy
  // it without doing so. A future carrier that replaces `liveness` keeps this green.
  //
  // The limit, stated rather than implied: a label carried only OUTSIDE this payload — a separate
  // endpoint, a console-side join — would leave this green. That is deliberate (a label the console
  // cannot see in GET /v1/org/sessions has not done the job #16116 gave it) but it is a real limit, and
  // it is why the assertion says "distinguishable", not "labelled".
  it("a chatless app-start row is distinguishable from a chat-backed one (the #16116 label)", async () => {
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    const codexHome = tempDir("oc-proxy-codex-");
    mkdirSync(path.join(codexHome, ".codex"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", codexHome, "--client", "codex"], childEnv(codexHome));
    expect(connected.code).toBe(0);
    const folder = gitProject("ProxyProj");
    const script = path.join(codexHome, ".opencadre", "bin", "opencadre-mcp.mjs");

    const idle = new ProxyProcess(script, childEnv(codexHome), folder, "codex");
    proxies.push(idle);
    await idle.initialize();
    await idle.notify("notifications/initialized");

    const chat = new ProxyProcess(script, childEnv(codexHome), folder, "codex");
    proxies.push(chat);
    await chat.initialize();
    await chat.callTool("set_status", { task: "chat-backed" });
    await chat.callTool("get_active_agents");

    const rows = (await liveSessions(hub.url, operatorKey, minted.deviceId)) as SessionRow[];
    const appStart = rows.find((s) => s.currentTask === null);
    const chatBacked = rows.find((s) => s.currentTask !== null);

    // Identity and liveness are per-session by construction and cannot be the label: a fresh agentId
    // and name are minted per launch, and the timestamps differ because the rows were created at
    // different moments. What is left is the part of the payload the console reasons over.
    const shape = (r: SessionRow) => {
      const { agentId, agentName, currentTask, lastHeartbeatAt, createdAt, ...rest } = r;
      return rest;
    };
    const left = shape(appStart!);
    const differing = Object.keys(left).filter(
      (k) => JSON.stringify((left as Record<string, unknown>)[k]) !== JSON.stringify((shape(chatBacked!) as Record<string, unknown>)[k]),
    );

    expect(
      differing,
      "nothing in GET /v1/org/sessions tells an app-start row from a chat-backed row, so the #16116 label has no carrier the console can read",
    ).not.toEqual([]);
    await idle.close();
    await chat.close();
  }, 60_000);
});

describe("the device credential stays confined", () => {
  it("never appears in any proxy's stdout or stderr", () => {
    expect(proxies.length).toBeGreaterThan(5);
    expect(allOutput()).not.toContain(credential);
    expect(allOutput()).not.toMatch(/dev_[0-9a-f]{48}/);
  });
});
