// Antigravity, LIVE: the real `agy` CLI, set up in a throwaway home by `opencadre connect`, driven by a scripted Gemini
// endpoint (agy's direct Gemini API route: `"modelProvider": "gemini"` plus GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL;
// no Google account), against a real in-process hub. Skipped unless OPENCADRE_AGY_BIN names the binary
// (docs/qa/HARNESS-MEASUREMENT.md §10), so the suite never depends on a 200 MB download:
//   OPENCADRE_AGY_BIN=/path/to/agy npx vitest run tests/antigravity-live.test.ts
// The script: 1) call OpenCadre's set_status through agy's `call_mcp_tool`, 2) run `rm -rf ./probe-dir`, 3) finish. The
// test decides the held command (deny), and reads what the model was shown.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedGemini } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const AGY = process.env.OPENCADRE_AGY_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!AGY || !existsSync(AGY))("Antigravity LIVE: the real agy CLI, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("AgyLive");
  let model: Awaited<ReturnType<typeof scriptedGemini>>;

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Agy Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:agylive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-agy-live-");
    // agy's own first-run state, as `agy` itself would have left it.
    mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "antigravity"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedGemini([
      { tool: /^call_mcp_tool$/, args: { ServerName: "opencadre-session", ToolName: "set_status", Arguments: { task: "live agy" }, toolSummary: "Status", toolAction: "Setting status" } },
      { tool: /^run_command$/, args: { CommandLine: "rm -rf ./probe-dir", Cwd: project, WaitMsBeforeAsync: 2000, toolSummary: "Clean", toolAction: "Cleaning" } },
      "done",
    ]);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one conversation: its own agent from the id agy puts on each MCP call, its risky command held as that agent and denied, and mail at turn end", async () => {
    const env = {
      ...childEnv(home),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PWD: project,
      GEMINI_API_KEY: "scripted",
      GOOGLE_GEMINI_BASE_URL: model.url,
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    // --dangerously-skip-permissions: agy's own prompt would otherwise refuse the command in print mode before anyone
    // decides; its PreToolUse hooks (ours) still run first.
    const run = spawn(AGY!, ["-p", "Do the task.", "--output-format", "json", "--print-timeout", "240s", "--dangerously-skip-permissions"], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    // 1) The conversation's set_status lands on an agent of its own, named for this project.
    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live agy")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent, `${out}\nTOOLS: ${model.seen.map((s) => s.tools.filter((t) => /mcp|command/.test(t)).join(",")).join(" | ")}`).toMatch(/^Antigravity-AgyLive-/);

    // Mail while it works: it must reach the conversation when its turn ends (the Stop hook continues it).
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for agy", priority: "high" }),
    });

    // 2) The risky command waits for a decision, requested as that same agent.
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 1200 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending, `${out}\nRESPONSES: ${model.seen.map((s) => (s.body.match(/"functionResponse":\{.{0,400}/g) ?? []).join(" ")).join(" | ").slice(-3000)}`).toHaveLength(1);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });

    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    // 3) The end of the turn was kept going once with the mail.
    expect(shown).toMatch(/live mail for agy/);
    // The conversation was told who it is at its first turn.
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
  });
});
