// Crush, LIVE: the real `crush` (charmbracelet/crush release), set up in a throwaway home by `opencadre connect`,
// driven by a scripted OpenAI-compatible model through Crush's own `openai-compat` provider setting (no account),
// against a real in-process hub. Skipped unless OPENCADRE_CRUSH_BIN names the binary
// (docs/qa/HARNESS-MEASUREMENT.md §15):
//   OPENCADRE_CRUSH_BIN=/path/to/crush npx vitest run tests/crush-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) bash `rm -rf ./probe-dir`, 3) `ls` (mail arrives with a tool's result:
// Crush has no end-of-turn hook, and awareness is quiet on bash, whose denial drops it), 4) finish. The test denies the held command and reads what the model was shown.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedModel } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const CRUSH = process.env.OPENCADRE_CRUSH_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!CRUSH || !existsSync(CRUSH))("Crush LIVE: the real binary, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("CrushLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  const crushEnv = () => childEnv(home, { XDG_CONFIG_HOME: "", CRUSH_GLOBAL_CONFIG: "" });

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Crush Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:crushlive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-crush-live-");
    model = await scriptedModel([
      { tool: /^mcp_opencadre-session_set_status$/, args: { task: "live crush" } },
      { tool: /^bash$/, args: { command: "rm -rf ./probe-dir", description: "clean" } },
      { tool: /^ls$/, args: { path: "." } },
      "done",
    ]);
    // The user's side: a model to talk to, and Crush's own permission for the tools the script uses.
    const file = path.join(home, ".config", "crush", "crush.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      providers: { scripted: { type: "openai-compat", base_url: `${model.url}/v1`, api_key: "x", models: [{ id: "test-model", name: "T", context_window: 100000, default_max_tokens: 1000 }] } },
      models: { large: { provider: "scripted", model: "test-model" }, small: { provider: "scripted", model: "test-model" } },
      options: { disable_provider_auto_update: true, disable_metrics: true },
      permissions: { allowed_tools: ["bash", "ls", "mcp_opencadre-session_set_status"] },
    }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "crush"], crushEnv());
    expect(connected.code, connected.err).toBe(0);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held as that agent and denied, mail with a later tool's result", async () => {
    const env = {
      ...crushEnv(),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TERM: "dumb",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      OPENCADRE_AWARENESS_MIN_INTERVAL: "0",
    };
    const run = spawn(CRUSH!, ["run", "-q", "Do the task."], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    run.stdin.end();
    const exited = new Promise<number | null>((r) => run.on("close", r));

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live crush")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent ?? "", `${out.slice(-2000)}\nREQUESTS: ${model.seen.length}\nTOOLS: ${[...new Set(model.seen.flatMap((s) => s.tools))].join(",")}`).toMatch(/^Crush-CrushLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for crush", priority: "high" }),
    });

    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 1200 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending, out.slice(-2000)).toHaveLength(1);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });

    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
    expect(shown).toMatch(/Operator sent you a message/);
  });
});
