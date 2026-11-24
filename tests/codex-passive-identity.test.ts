import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADOPT_LIVE_HEADER, RESOLVE_ONLY_HEADER, resolveHub, STAMP_FIELD, mintStamp } from "../scripts/opencadre-config.mjs";
import { childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir } from "./helpers/device-hub.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
const PROJECT = "local:passive-codex";
let hub: Awaited<ReturnType<typeof startHub>>;
let orgId: string;
let operatorKey: string;
const project = gitProject("passive-codex");
const proxies: ProxyProcess[] = [];

async function setup(trusted = true) {
  const home = tempDir("codex-passive-home-");
  const minted = await mintDevice(hub.url, operatorKey, "codex");
  const r = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
  expect(r.code, r.err).toBe(0);
  if (trusted) {
    const hooksFile = path.join(home, ".codex", "hooks.json");
    const groups = JSON.parse(readFileSync(hooksFile, "utf8")).hooks.PreToolUse;
    const group = groups.findIndex((g: any) => g.hooks.some((h: any) => h.command.includes("opencadre-session-stamp")));
    const handler = groups[group].hooks.findIndex((h: any) => h.command.includes("opencadre-session-stamp"));
    const config = path.join(home, ".codex", "config.toml");
    writeFileSync(config, readFileSync(config, "utf8") + "\n[hooks.state.'" + hooksFile + ":pre_tool_use:" + group + ":" + handler + "']\ntrusted_hash = \"sha256:test\"\n");
  }
  return { home, device: minted.deviceId, bin: path.join(home, ".opencadre", "bin"), credential: computerCredential(home) };
}
function hook(f: Awaited<ReturnType<typeof setup>>, file: string, event: string, sid: string | undefined, extra = {}, report = false) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(f.bin, file), "--client", "codex", ...(report ? ["--report"] : [])], {
      cwd: project, env: childEnv(f.home, { ...GATE_TEST_ENV, OPENCADRE_AWARENESS_STATE_DIR: tempDir("codex-passive-state-"), OPENCADRE_GATE_MODE: "strict", OPENCADRE_APPROVAL_WAIT: "1" }),
    });
    let out = "", err = "";
    child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    child.on("close", code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sid, cwd: project, source: "startup", transcript_path: null, tool_name: "Bash", tool_input: { command: "git status" }, ...extra }));
  });
}
const rows = (f: Awaited<ReturnType<typeof setup>>) => liveSessions(hub.url, operatorKey, f.device);
function proxy(f: Awaited<ReturnType<typeof setup>>) { const p = new ProxyProcess(path.join(f.bin, "opencadre-mcp.mjs"), childEnv(f.home), project, "codex"); proxies.push(p); return p; }
const stamped = (f: Awaited<ReturnType<typeof setup>>, sid: string, task: string) => ({ task, [STAMP_FIELD]: mintStamp(f.credential, sid) });
beforeAll(async () => { hub = await startHub(); ({ orgId, operatorKey } = await operatorWorkspace("Passive Codex")); await enableProject(hub.url, operatorKey, PROJECT); }, 60_000);
afterAll(async () => { for (const p of proxies) p.child.kill(); await hub?.close(); });

describe("Codex passive hooks do not create identities", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("trusted hooks resolve only their exact chat, without adopting siblings", async () => {
    const f = await setup();
    const h = resolveHub({ client: "codex", cwd: project, home: f.home, env: childEnv(f.home), sessionId: "passive-A" }).headers;
    expect(h[RESOLVE_ONLY_HEADER]).toBe("1"); expect(h[ADOPT_LIVE_HEADER]).toBeUndefined();
  });
  it("startup/prompt/stop and harmless command hooks for disposable sessions create no rows", async () => {
    const f = await setup();
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      await hook(f, "opencadre-awareness.mjs", event, "disposable-" + event);
      expect(await rows(f), event).toHaveLength(0);
    }
    await hook(f, "opencadre-approval-gate.mjs", "PreToolUse", "harmless");
    await hook(f, "opencadre-approval-gate.mjs", "PostToolUse", "passive-report", { tool_input: { command: "rm -rf ./src" } }, true);
    expect(await rows(f)).toHaveLength(0);
  });
  it("two real stamped chats establish distinct identities; passive hooks and reopen keep them", async () => {
    const f = await setup(), p = proxy(f); await p.initialize();
    for (const sid of ["chat-A", "chat-B"]) expect((await p.callTool("set_status", stamped(f, sid, sid))).error).toBeUndefined();
    const before = await rows(f); expect(before).toHaveLength(2);
    const unknown = await hook(f, "opencadre-awareness.mjs", "SessionStart", "unrelated-background");
    expect(unknown.out).not.toContain("You are ");
    expect((await rows(f)).map(r => r.agentId).sort()).toEqual(before.map(r => r.agentId).sort());
    const said = await hook(f, "opencadre-awareness.mjs", "SessionStart", "chat-A");
    expect(said.out).toContain("You are " + before.find((r: any) => r.currentTask === "chat-A")!.agentName);
    const reopened = proxy(f); await reopened.initialize(); await reopened.callTool("set_status", stamped(f, "chat-A", "reopened"));
    expect((await rows(f)).map(r => r.agentId).sort()).toEqual(before.map(r => r.agentId).sort());
  });
  for (const decision of ["deny", "approve"] as const) it("a first risky command waits for actual person " + decision + " and reuses its identity on MCP", async () => {
    const f = await setup();
    const running = hook(f, "opencadre-approval-gate.mjs", "PreToolUse", "risky-chat", { tool_input: { command: "rm -rf ./src" } });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: ReturnType<typeof listApprovals> = [];
    for (let n = 0; n < 80 && pending.length === 0; n++) { pending = listApprovals(orgId, { status: "pending" }); if (!pending.length) await new Promise(r => setTimeout(r, 50)); }
    expect(pending).toHaveLength(1); expect(await rows(f)).toHaveLength(1);
    expect((await decideAsPerson(hub.url, orgId, pending[0].id, { decision })).ok).toBe(true);
    const result = await running;
    expect(JSON.parse(result.out).hookSpecificOutput.permissionDecision).toBe(decision === "approve" ? "allow" : "deny");
    const before = (await rows(f))[0].agentId;
    const p = proxy(f); await p.initialize(); await p.callTool("set_status", stamped(f, "risky-chat", "real work"));
    expect((await rows(f)).map(r => r.agentId)).toEqual([before]);
  });
  it("untrusted or missing-session risky hooks fail closed without creating a synthetic identity", async () => {
    for (const trusted of [false, true]) {
      const f = await setup(trusted);
      const result = await hook(f, "opencadre-approval-gate.mjs", "PreToolUse", trusted ? undefined : "untrusted", { tool_input: { command: "rm -rf ./src" } });
      expect(JSON.parse(result.out).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(await rows(f)).toHaveLength(0);
    }
  });
});
