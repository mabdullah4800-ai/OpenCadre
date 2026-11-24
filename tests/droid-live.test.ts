// Factory Droid, LIVE: the real `droid` (npm @factory/cli-<platform>), set up in a throwaway home by `opencadre
// connect`, driven by a scripted OpenAI-compatible model through Droid's own `customModels` setting (no account), against
// a real in-process hub. Skipped unless OPENCADRE_DROID_BIN names the binary (docs/qa/HARNESS-MEASUREMENT.md §14):
//   OPENCADRE_DROID_BIN=/path/to/droid npx vitest run tests/droid-live.test.ts
// The script: 1) call OpenCadre's set_status (a deferred MCP tool, called by its exact name), 2) Execute
// `rm -rf ./probe-dir`, 3) finish. The test denies the held command, sends mail while the session works, and reads what
// the model was shown.
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

const DROID = process.env.OPENCADRE_DROID_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!DROID || !existsSync(DROID))("Factory Droid LIVE: the real binary, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("DroidLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Droid Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:droidlive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-droid-live-");
    mkdirSync(path.join(home, ".factory"), { recursive: true });
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "droid"], childEnv(home, { FACTORY_HOME_OVERRIDE: "" }));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedModel([
      { tool: /^opencadre-session_+set_status$/, name: "opencadre-session___set_status", args: { task: "live droid" } },
      { tool: /^Execute$/, args: { command: "rm -rf ./probe-dir", riskLevel: "high", riskLevelReason: "cleanup" } },
      "done",
    ]);
    // The user's own hook that approves every Execute, placed BEFORE OpenCadre's: Droid's first JSON decision wins, so
    // OpenCadre denies by exit 2, which still blocks (review of e7ee431, B1).
    const hooksFile = path.join(home, ".factory", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    writeFileSync(path.join(home, "allow.mjs"), 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"user auto-approve"}}));');
    hooks.PreToolUse.unshift({ matcher: "Execute", hooks: [{ type: "command", command: `node "${path.join(home, "allow.mjs")}"` }] });
    writeFileSync(hooksFile, JSON.stringify(hooks));
    // The user's side: a model to talk to (Droid's own custom-model setting).
    writeFileSync(path.join(home, ".factory", "settings.json"), JSON.stringify({ customModels: [{ model: "test-model", displayName: "Scripted", baseUrl: `${model.url}/v1`, apiKey: "scripted", provider: "generic-chat-completion-api" }] }));
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent from its calls' _meta, its risky command held as that agent and denied, mail at turn end", async () => {
    const env = {
      ...childEnv(home, { FACTORY_HOME_OVERRIDE: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TERM: "dumb",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const run = spawn(DROID!, ["exec", "--auto", "high", "-m", "custom:Scripted-0", "Do the task."], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    run.stdin.end();
    const exited = new Promise<number | null>((r) => run.on("close", r));

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live droid")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    const log = () => { try { return readFileSync(path.join(home, ".factory", "logs", "droid-log-single.log"), "utf8").slice(-3000); } catch { return ""; } };
    expect(agent ?? "", `${out.slice(-2000)}\nREQUESTS: ${model.seen.length}\n${log()}`).toMatch(/^Droid-DroidLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for droid", priority: "high" }),
    });

    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 1200 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending, `${out.slice(-2000)}\n${log()}`).toHaveLength(1);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });

    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    expect(shown).toMatch(/live mail for droid/);
  });
});
