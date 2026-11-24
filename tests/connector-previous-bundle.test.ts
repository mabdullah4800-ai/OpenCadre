// Actual prior installer and helpers, extracted from this immutable Git commit, against the new hub.
// These are protocol/install contracts; they do not claim a vendor desktop smoke run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readTarGz } from "../scripts/cli-build-info.mjs";
import { childEnv, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir } from "./helpers/device-hub.js";
const PRIOR = "25b6250b40893406f2ca655ef998f5e0f0b46a95";
let hub: Awaited<ReturnType<typeof startHub>>;
let source: string;
const proxies: ProxyProcess[] = [];
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
beforeAll(async () => {
  source = tempDir("prior-bundle-");
  const tar = join(source, "source.tar");
  execFileSync("git", ["archive", "--format=tar", "--output", tar, PRIOR, "cli", "scripts", "examples/hooks", "examples/opencode-plugin"], { cwd: process.cwd() });
  for (const file of readTarGz(gzipSync(readFileSync(tar)))) {
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) throw new Error("unsafe archive path");
    mkdirSync(dirname(join(source, file.path)), { recursive: true });
    writeFileSync(join(source, file.path), file.bytes);
  }
  hub = await startHub();
}, 30000);
afterAll(async () => { for (const p of proxies) await p.close(); if (hub) await hub.close(); });
describe("supported previous bundle survives additive hub upgrade", () => {
  it.each(["claude-code", "codex", "cursor"])("%s installs, keeps its own identity, reads and replies to mail", async (client) => {
    const fleet = await operatorWorkspace("Prior " + client);
    const project = gitProject("PriorProject");
    await enableProject(hub.url, fleet.operatorKey, "local:PriorProject");
    const home = tempDir("prior-home-");
    const minted = await mintDevice(hub.url, fleet.operatorKey, client);
    const env = childEnv(home, { CLAUDE_CODE_SESSION_ID: "previous-chat", CLAUDE_CODE_HOST_SESSION_ID: "previous-host", CODEX_THREAD_ID: "previous-chat", CODEX_SESSION_ID: "previous-chat", CODEX_HOME: join(home, ".codex") });
    const connected = await runNode(join(source, "cli/bin/opencadre.mjs"), ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", client], env, project);
    expect(connected.code, connected.err).toBe(0);
    const credential = computerCredential(home);
    const bin = join(home, ".opencadre", "bin");
    const proxy = new ProxyProcess(join(bin, "opencadre-mcp.mjs"), env, project, client);
    proxies.push(proxy);
    await proxy.initialize();
    // Load the PRIOR generation's own signer, avoiding current code impersonating an old client.
    const generationId = readFileSync(join(bin, ".gen", "current"), "utf8").trim();
    const oldConfig = await import(/* @vite-ignore */ pathToFileURL(join(bin, ".gen", generationId, "opencadre-config.mjs")).href);
    const catalog = (await proxy.request("tools/list")).result.tools as { name: string }[];
    const toolName = (name: string) => {
      const found = catalog.find((t) => t.name === name || t.name === "opencadre_" + name);
      if (!found) throw new Error("missing prior tool: " + name);
      return found.name;
    };
    const stamped = () => client !== "cursor" ? {} : { _opencadre_stamp: oldConfig.mintStamp(credential, oldConfig.scopedSessionId(client, "previous-chat", env)) };
    const first = await proxy.callTool(toolName("get_active_agents"), stamped());
    const seats = await liveSessions(hub.url, fleet.operatorKey, minted.deviceId);
    expect(seats).toHaveLength(1);
    expect(first).toContain(seats[0].agentName);
    expect(seats[0].tool).toBe(client);
    const sent = await fetch(hub.url + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${fleet.operatorKey}`, "content-type": "application/json" }, body: JSON.stringify({ toAgent: seats[0].agentName, body: "previous bundle mail contract" }) });
    expect(sent.ok).toBe(true);
    const message = await sent.json();
    const inbox = await proxy.callTool(toolName("get_messages"), stamped());
    expect(inbox).toContain("previous bundle mail contract");
    const threadId = message.threadId ?? message.thread_id;
    expect(typeof threadId).toBe("string");
    expect(await proxy.callTool(toolName("reply"), { ...stamped(), threadId, body: "previous bundle replied" })).toContain("Reply sent");
    const again = await liveSessions(hub.url, fleet.operatorKey, minted.deviceId);
    expect(again.map((s) => s.agentId)).toEqual(seats.map((s) => s.agentId));
    if (client === "cursor") {
      const dated = oldConfig.mintStamp(credential, oldConfig.scopedSessionId(client, "previous-chat", env));
      const refused = await proxy.request("tools/call", { name: toolName("get_active_agents"), arguments: { _opencadre_stamp: { sid: dated.sid, sig: dated.sig } } });
      expect(refused.error?.message).toContain("stamp");
    }
    expect((proxy.out + proxy.err).includes(credential)).toBe(false);
    await proxy.close();
    proxies.splice(proxies.indexOf(proxy), 1);
  }, 30000);
});
