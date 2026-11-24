import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir } from "./helpers/device-hub.js";

/** `opencadre whoami|inbox|send|reply|status|wait`: a Claude Code chat acts as its own agent from its Bash tool, with no
 * restart, using the device credential plus the session ids Claude Code puts in that tool's environment. */

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

let hub: Awaited<ReturnType<typeof startHub>>;
let orgId: string;
let operatorKey: string;
let deviceId: string;
let home: string;
let credential: string;
const project = gitProject("CmdProj");
const outputs: string[] = [];

/** Runs a session command as the chat whose Bash tool has these session ids. */
async function as(session: Record<string, string>, ...args: string[]) {
  const r = await runNode(CLI, args, childEnv(home, session), project);
  outputs.push(r.out, r.err);
  return r;
}
const chat1 = { CLAUDE_CODE_SESSION_ID: "cmd-tool-1", CLAUDE_CODE_HOST_SESSION_ID: "cmd-host-1" };
const chat2 = { CLAUDE_CODE_SESSION_ID: "cmd-tool-2" };

beforeAll(async () => {
  hub = await startHub();
  ({ orgId, operatorKey } = await operatorWorkspace("Cmd Org"));
  await enableProject(hub.url, operatorKey, "local:cmdproj");
  const minted = await mintDevice(hub.url, operatorKey);
  deviceId = minted.deviceId;
  home = tempDir("oc-cmd-home-");
  const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"], childEnv(home));
  expect(connected.code).toBe(0);
  credential = computerCredential(home);
}, 60_000);

afterAll(() => hub.close());

describe("session commands", () => {
  let name1 = "";
  let name2 = "";
  let threadId = "";

  it("whoami: two session ids are two agents, each with a word name, both in the project", async () => {
    // A new chat's name is one word (sessions PR1), or on collision two words or a word and a number.
    const word = "[A-Z][a-z]+(?: [A-Z][a-z]+| \\d+)?";
    const r1 = await as(chat1, "whoami");
    expect(r1.err).toBe("");
    expect(r1.code).toBe(0);
    name1 = r1.out.match(new RegExp(`You are (${word}) in the OpenCadre workspace "Cmd Org" \\(this session's own identity\\)\\.`))?.[1] ?? "";
    expect(name1).not.toBe("");

    const r2 = await as(chat2, "whoami");
    name2 = r2.out.match(new RegExp(`You are (${word}) in `))?.[1] ?? "";
    expect(name2).not.toBe("");
    expect(name2).not.toBe(name1);
    const sessions = await liveSessions(hub.url, operatorKey, deviceId);
    expect(sessions.map((s) => s.agentName).sort()).toEqual([name1, name2].sort());
    // The client and project the name used to spell out are the session's own fields.
    for (const s of sessions) expect(s).toMatchObject({ tool: "claude-code", projectName: "CmdProj" });

    // The same chat again (and after /clear: same host session id) stays the same agent.
    expect((await as(chat1, "whoami")).out).toContain(name1);
    expect((await as({ ...chat1, CLAUDE_CODE_SESSION_ID: "cmd-tool-1-cleared" }, "whoami")).out).toContain(name1);
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(2);
  }, 60_000);

  it("send and inbox: mail goes to the other session by name; --peek leaves it unread", async () => {
    const sent = await as(chat1, "send", name2, "please review PR 150", "--priority", "high");
    expect(sent.code).toBe(0);
    threadId = sent.out.match(new RegExp(`^Sent to ${name2} \\((live|queued)\\)\\. Thread: (\\S+)$`, "m"))?.[2] ?? "";
    expect(threadId).not.toBe("");

    const peeked = await as(chat2, "inbox", "--peek");
    expect(peeked.out).toContain(`[high] from ${name1} · thread ${threadId}`);
    expect(peeked.out).toContain("  please review PR 150");
    expect(peeked.out).not.toContain("marked read");
    expect((await as(chat2, "inbox")).out).toMatch(/^1 message \(now marked read\):/);
    expect((await as(chat2, "inbox")).out.trim()).toBe("No new messages.");
    // Nothing leaked into the sender's own inbox.
    expect((await as(chat1, "inbox", "--peek")).out.trim()).toBe("No new messages.");
  }, 60_000);

  it("reply and wait: the reply lands on the sender's thread", async () => {
    const replied = await as(chat2, "reply", threadId, "on it");
    expect(replied.out.trim()).toBe(`Replied on thread ${threadId}.`);
    const waited = await as(chat1, "wait", "--seconds", "5");
    expect(waited.code).toBe(0);
    expect(waited.out).toContain(`from ${name2} · thread ${threadId}`);
    expect(waited.out).toContain("  on it");
    expect((await as(chat1, "wait", "--seconds", "1")).out.trim()).toBe("No new messages in 1 s.");
  }, 60_000);

  it("status sets this session's task", async () => {
    expect((await as(chat2, "status", "Reviewing PR 150")).out.trim()).toBe("Status set: Reviewing PR 150");
    const { agents } = await (await fetch(`${hub.url}/v1/agents`, { headers: { authorization: `Bearer ${operatorKey}` } })).json() as { agents: Array<{ name: string; current_task: string | null }> };
    expect(agents.find((a) => a.name === name2)?.current_task).toBe("Reviewing PR 150");
    expect(agents.find((a) => a.name === name1)?.current_task).toBeNull();
  }, 30_000);
});

describe("session commands fail closed", () => {
  it("with no session id: a clear error, and no agent is created", async () => {
    const before = (await liveSessions(hub.url, operatorKey, deviceId)).length;
    const r = await as({ CLAUDE_CODE_HOST_SESSION_ID: "cmd-host-9" }, "inbox");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.trim()).toBe("opencadre: No session id from Claude Code (CLAUDE_CODE_SESSION_ID isn't set), so there's no way to tell which session this is. Run it from a Claude Code chat's Bash tool.");
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toHaveLength(before);
  }, 30_000);

  it("with no device credential: says how to connect", async () => {
    const r = await runNode(CLI, ["whoami"], childEnv(tempDir("oc-cmd-empty-"), chat1), project);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe("opencadre: OpenCadre isn't connected on this machine: run the connect command from the console.");
  }, 30_000);

  it("a named agent for the folder wins, exactly as for the hooks and the proxy", async () => {
    const { registerAgent } = await import("../src/service.js");
    const named = registerAgent(orgId, "Named-Cmd-Agent");
    const folder = gitProject("NamedCmd");
    const namedHome = tempDir("oc-cmd-named-");
    writeFileSync(path.join(namedHome, ".claude.json"), JSON.stringify({ projects: { [folder]: { mcpServers: { opencadre: { type: "http", url: `${hub.url}/mcp`, headers: { Authorization: `Bearer ${named.apiKey}` } } } } } }));
    const before = (await liveSessions(hub.url, operatorKey)).length;
    const r = await runNode(CLI, ["whoami"], childEnv(namedHome, chat1), folder);
    expect(r.out.trim()).toBe('You are Named-Cmd-Agent in the OpenCadre workspace "Cmd Org" (the named agent configured for this folder).');
    expect(await liveSessions(hub.url, operatorKey)).toHaveLength(before);
    outputs.push(r.out, r.err);
    expect(r.out + r.err).not.toContain(named.apiKey);
  }, 30_000);

  it("outside an enabled project: says so and how to enable it, and creates nothing", async () => {
    const before = (await liveSessions(hub.url, operatorKey)).length;
    const r = await runNode(CLI, ["inbox"], childEnv(home, chat1), gitProject("NotEnabledCmd"));
    outputs.push(r.out, r.err);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.trim()).toBe("opencadre: OpenCadre isn't enabled for this project. Enable it in the console under Settings → Projects.");
    expect(await liveSessions(hub.url, operatorKey)).toHaveLength(before);
  }, 30_000);

  it("rejects bad arguments before touching the hub", async () => {
    expect((await as(chat1, "wait", "--seconds", "0")).code).toBe(2);
    expect((await as(chat1, "send", "Some-Agent")).err).toMatch(/send needs an agent name and a message/);
    expect((await as(chat1, "send", "x", "hi", "--priority", "urgent")).err).toMatch(/--priority must be high, medium or low/);
  }, 30_000);

  it("a hub refusal says why, never with the credential", async () => {
    const r = await as(chat1, "send", "Nobody-Here", "hello?");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^opencadre: The hub refused this \(HTTP 404\): No agent found matching "Nobody-Here"/);
  }, 30_000);

  it("never prints the device credential", () => {
    expect(outputs.length).toBeGreaterThan(10);
    expect(outputs.join("\n")).not.toContain(credential);
    expect(outputs.join("\n")).not.toMatch(/dev_[0-9a-f]{48}/);
  });
});

