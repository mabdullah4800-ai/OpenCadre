// Grok Build, LIVE: the real `grok` (from x.ai/cli), set up in a throwaway home by `opencadre connect`, driven by a
// scripted model through Grok's own custom-model setting (`[model.<name>] base_url` in ~/.grok/config.toml; no xAI
// account), against a real in-process hub. Skipped unless OPENCADRE_GROK_BIN names the binary
// (docs/qa/HARNESS-MEASUREMENT.md §12):
//   OPENCADRE_GROK_BIN=/path/to/grok npx vitest run tests/grok-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) run `rm -rf ./probe-dir`, 3) the same through Grok's `monitor` tool
// (review of 7ffc12c, B1), 4) finish. The test denies both held commands, sends mail while the session works, and
// reads what the model was shown.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedModel } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const GROK = process.env.OPENCADRE_GROK_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!GROK || !existsSync(GROK))("Grok Build LIVE: the real binary, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("GrokLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Grok Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:groklive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-grok-live-");
    mkdirSync(path.join(home, ".grok"), { recursive: true });
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "grok"], childEnv(home, { GROK_HOME: "" }));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedModel([
      // Grok offers MCP tools through its `use_tool` dispatcher, as `<server>__<tool>`.
      { tool: /^use_tool$/, args: { tool_name: "opencadre-session__set_status", tool_input: { task: "live grok" } } },
      { tool: /^run_terminal_command$/, args: { command: "rm -rf ./probe-dir", description: "clean" } },
      { tool: /^monitor$/, args: { command: "rm -rf ./probe-dir && echo DONE", description: "watch the cleanup" } },
      "done",
    ]);
    // The user's side: a model to talk to, and no self-update.
    appendFileSync(path.join(home, ".grok", "config.toml"), `\n[model.scripted]\nmodel = "test-model"\nbase_url = "${model.url}"\nname = "Scripted"\napi_key = "scripted"\ncontext_window = 128000\n\n[cli]\nauto_update = false\n`);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held as that agent and denied, and mail at turn end", async () => {
    const env = {
      ...childEnv(home, { GROK_HOME: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PWD: project,
      TERM: "dumb",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const run = spawn(GROK!, ["-p", "Do the task.", "-m", "scripted", "--output-format", "json", "--always-approve"], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live grok")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent ?? "", `${out.slice(-3000)}\nTOOLS: ${[...new Set(model.seen.flatMap((s) => s.tools))].join(",")}\nREQUESTS: ${model.seen.length}\nTOOLMSGS: ${model.seen.map((s) => (s.body.match(/"role":"tool".{0,300}/g) ?? []).join(" ")).join(" | ").slice(-2500)}`).toMatch(/^Grok-GrokLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for grok", priority: "high" }),
    });

    const { listApprovals } = await import("../src/approvals.js");
    // Both shell tools are held as the session's agent, one after the other.
    for (const tool of ["run_terminal_command", "monitor"]) {
      let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
      for (let i = 0; i < 1200 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending, `${tool}\n${out}\nTOOLMSGS: ${model.seen.map((s) => (s.body.match(/"role":"tool".{0,400}/g) ?? []).join(" ")).join(" | ").slice(-3000)}`).toHaveLength(1);
      expect(pending[0].requested_by_agent_name).toBe(agent);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });
    }

    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    expect(shown).toMatch(/live mail for grok/);
  });
});
