// Mistral Vibe, LIVE: the real `vibe` (PyPI mistral-vibe), set up in a throwaway home by `opencadre connect`, driven by
// a scripted OpenAI-compatible model through Vibe's own `[[providers]]` setting (no account), against a real in-process
// hub. Skipped unless OPENCADRE_VIBE_BIN names the binary (docs/qa/HARNESS-MEASUREMENT.md §16):
//   OPENCADRE_VIBE_BIN=/path/to/vibe npx vitest run tests/vibe-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) bash `rm -rf ./probe-dir`, 3) finish. The test denies the held command,
// sends mail while the session works, and reads what the model was shown (mail arrives when the turn ends).
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

const VIBE = process.env.OPENCADRE_VIBE_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!VIBE || !existsSync(VIBE))("Mistral Vibe LIVE: the real binary, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("VibeLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  const vibeEnv = () => childEnv(home, { VIBE_HOME: "" });

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Vibe Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:vibelive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-vibe-live-");
    model = await scriptedModel([
      { tool: /^opencadre-session_set_status$/, args: { task: "live vibe" } },
      { tool: /^bash$/, args: { command: "rm -rf ./probe-dir" } },
      "done",
    ]);
    // The user's side: a model to talk to (Vibe's own provider setting).
    mkdirSync(path.join(home, ".vibe"), { recursive: true });
    writeFileSync(path.join(home, ".vibe", "config.toml"), [
      'active_model = "scripted"',
      "[[providers]]", 'name = "scripted"', `api_base = "${model.url}/v1"`, 'api_key_env_var = "SCRIPTED_KEY"', 'api_style = "openai"',
      "[[models]]", 'name = "test-model"', 'provider = "scripted"', 'alias = "scripted"', "",
    ].join("\n"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "vibe"], vibeEnv());
    expect(connected.code, connected.err).toBe(0);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held as that agent and denied, mail at turn end", async () => {
    const env = {
      ...vibeEnv(),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${path.dirname(VIBE!)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TERM: "dumb",
      SCRIPTED_KEY: "scripted",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const run = spawn(VIBE!, ["--trust", "--auto-approve", "-p", "Do the task."], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    run.stdin.end();
    const exited = new Promise<number | null>((r) => run.on("close", r));

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live vibe")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent ?? "", `${out.slice(-2500)}\nREQUESTS: ${model.seen.length}\nTOOLS: ${[...new Set(model.seen.flatMap((s) => s.tools))].join(",")}\nTOOLMSGS: ${model.seen.map((s) => (s.body.match(/"role":"tool".{0,300}/g) ?? []).join(" ")).join(" | ").slice(-1500)}`).toMatch(/^Vibe-VibeLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for vibe", priority: "high" }),
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

    expect(await exited, out.slice(-2000)).toBe(0);
    expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
    const shown = model.seen.map((s) => s.body).join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
    expect(shown).toMatch(/live mail for vibe|unread OpenCadre message/);
  });
});
