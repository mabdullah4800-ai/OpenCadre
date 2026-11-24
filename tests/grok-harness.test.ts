// Grok Build: what connect writes and what doctor reads, and the Claude Code gate standing down in a Grok session once
// Grok has a gate of its own (Grok also runs ~/.claude/settings.json hooks). Run live in tests/grok-live.test.ts.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostGateInstalled } from "../scripts/opencadre-config.mjs";
import { childEnv, CLI, enableProject, gitProject, mintDevice, operatorWorkspace, runNode, startHub, tempDir } from "./helpers/device-hub.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe("Grok Build, installed by connect", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let home: string;
  let bin: string;
  const project = gitProject("GrokProj");
  const env = () => childEnv(home, { GROK_HOME: "" });

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Grok Org");
    await enableProject(hub.url, ws.operatorKey, "local:grokproj");
    const minted = await mintDevice(hub.url, ws.operatorKey, "auto");
    home = tempDir("oc-grok-e2e-");
    // The user's own config, which connect must keep.
    mkdirSync(path.join(home, ".grok"), { recursive: true });
    writeFileSync(path.join(home, ".grok", "config.toml"), '[model.mine]\nmodel = "x"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n');
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "grok"], env());
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await hub.close();
  });

  it("writes its server into config.toml beside the user's own, and its own hook file", () => {
    const toml = readFileSync(path.join(home, ".grok", "config.toml"), "utf8");
    expect(toml).toContain('[model.mine]\nmodel = "x"');
    expect(toml).toContain("[mcp_servers.linear]");
    expect(toml).toContain(`[mcp_servers.opencadre-session]\ncommand = "node"\nargs = [${JSON.stringify(path.join(bin, "opencadre-mcp.mjs"))}, "--client", "grok"]`);
    const hooks = JSON.parse(readFileSync(path.join(home, ".grok", "hooks", "opencadre.json"), "utf8")).hooks;
    expect(hooks.PreToolUse).toEqual([{ matcher: "^(run_terminal_command|monitor)$", hooks: [{ type: "command", command: `node "${path.join(bin, "opencadre-approval-gate.mjs")}" --client grok`, timeout: 600 }] }]);
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
    expect(hostGateInstalled("grok", { home, env: env() })).toBe(true);
  });

  it("the Claude Code gate stands down on a Grok session's payload, since Grok's own gate holds it", async () => {
    const payload = {
      hook_event_name: "PreToolUse", hookEventName: "pre_tool_use", session_id: "g-1", sessionId: "g-1", workspaceRoot: project, cwd: project,
      permission_mode: "default", tool_name: "run_terminal_command", tool_input: { command: "rm -rf ./src" },
    };
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [path.join(bin, "opencadre-approval-gate.mjs"), "--client", "claude-code"], { env: { ...env(), OPENCADRE_GATE_MODE: "strict" } });
      let o = "";
      child.stdout.on("data", (c) => (o += c));
      child.on("close", () => resolve(o));
      child.stdin.end(JSON.stringify(payload));
    });
    expect(out).toBe("");
  });

  it("doctor --client grok finds the server and the hooks", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "grok", "--home", home], env());
    expect(r.out).toMatch(/mcp=configured/);
    expect(r.out).toMatch(/hooks=present/);
  });
});
