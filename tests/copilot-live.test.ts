// GitHub Copilot CLI, LIVE: the real `copilot` binary, installed into a throwaway home by `opencadre connect`, driven
// by a scripted model (Copilot's BYOK mode needs no GitHub sign-in: COPILOT_PROVIDER_BASE_URL), against a real
// in-process hub. Skipped unless OPENCADRE_COPILOT_BIN names the binary (docs/qa/HARNESS-MEASUREMENT.md §8), so the
// suite never depends on a 170 MB download; run it whenever the adapter or Copilot changes:
//   OPENCADRE_COPILOT_BIN=/path/to/copilot npx vitest run tests/copilot-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) run `rm -rf ./probe-dir` in bash, 3) finish. The test decides the held
// command (deny), sends mail while the session works, and reads what the model was shown.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedModel } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const COPILOT = process.env.OPENCADRE_COPILOT_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!COPILOT || !existsSync(COPILOT))("Copilot CLI LIVE: the real binary, our hooks, a real hub", { timeout: 240_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("CopilotLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Copilot Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:copilotlive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-copilot-live-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "copilot"], childEnv(home, { COPILOT_HOME: "" }));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedModel([
      { tool: /^opencadre-session-set_status$/, args: { task: "live copilot" } },
      { tool: /^(bash|powershell)$/, args: { command: "rm -rf ./probe-dir", description: "clean", mode: "sync", initial_wait: 10 } },
      "done",
    ]);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held and denied, and mail delivered at the end of its turn", async () => {
    const env = {
      ...childEnv(home, { COPILOT_HOME: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TERM: "dumb",
      COPILOT_PROVIDER_BASE_URL: model.url,
      COPILOT_PROVIDER_API_KEY: "test",
      COPILOT_MODEL: "gpt-4.1",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const run = spawn(COPILOT!, ["-p", "Do the task.", "--allow-all-tools", "--no-auto-update"], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    // 1) The session's set_status lands on an agent of its own.
    let agent: string | undefined;
    for (let i = 0; i < 600 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live copilot")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent, out).toMatch(/^Copilot-CopilotLive-/);
    // Mail while it works: it must reach the session when its turn ends.
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for copilot", priority: "high" }),
    });

    // 2) The risky command waits for a decision, requested as that same agent.
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 600 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending, out).toHaveLength(1);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });

    expect(await exited, out).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    // 3) The end of the turn was kept going once with the mail, as a new prompt.
    expect(shown).toMatch(/live mail for copilot/);
    // And the session was told who it is at the start.
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
  });
});
