// Goose, LIVE: the real `goose` binary (npm @aaif/goose-binary-<platform>), set up in a throwaway home by
// `opencadre connect`, driven by a scripted model through Goose's own OpenAI provider settings (OPENAI_HOST; no
// account), against a real in-process hub. Skipped unless OPENCADRE_GOOSE_BIN names the binary
// (docs/qa/HARNESS-MEASUREMENT.md §7), so the suite never depends on a 300 MB download:
//   OPENCADRE_GOOSE_BIN=/path/to/goose npx vitest run tests/goose-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) run `rm -rf ./probe-dir` in the shell, 3) finish. The test decides the
// held command (deny), sends mail while the session works, and reads what the model was shown.
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

const GOOSE = process.env.OPENCADRE_GOOSE_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!GOOSE || !existsSync(GOOSE))("Goose LIVE: the real binary, our extension and plugin, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("GooseLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  const gooseEnv = (extra: Record<string, string> = {}) => childEnv(home, { XDG_CONFIG_HOME: "", GOOSE_PATH_ROOT: "", ...extra });

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Goose Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:gooselive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-goose-live-");
    model = await scriptedModel([
      { tool: /set_status$/, args: { task: "live goose" } },
      { tool: /(^|__)shell$/, args: { command: "rm -rf ./probe-dir" } },
      "done",
    ]);
    // The user's own Goose setup: a model to talk to and the developer extension (its shell tool).
    const config = path.join(home, ".config", "goose", "config.yaml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, [
      "GOOSE_PROVIDER: openai",
      "GOOSE_MODEL: test-model",
      "GOOSE_MODE: auto",
      "extensions:",
      "  developer:",
      "    enabled: true",
      "    type: platform",
      "    name: developer",
      "    bundled: true",
      "",
    ].join("\n"));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "goose"], gooseEnv());
    expect(connected.code, connected.err).toBe(0);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held and denied, and mail at the end of its turn", async () => {
    const host = new URL(model.url);
    const env = {
      ...gooseEnv(),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PWD: project,
      OPENAI_API_KEY: "scripted",
      OPENAI_HOST: `${host.protocol}//${host.host}`,
      OPENAI_BASE_PATH: "v1/chat/completions",
      GOOSE_DISABLE_KEYRING: "1",
      GOOSE_TELEMETRY_ENABLED: "false",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const run = spawn(GOOSE!, ["run", "--no-session", "-t", "Do the task."], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    // 1) The session's set_status lands on an agent of its own.
    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live goose")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent, `${out}\nTOOLS: ${[...new Set(model.seen.flatMap((s) => s.tools))].join(",")}`).toMatch(/^Goose-GooseLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for goose", priority: "high" }),
    });

    // 2) The risky command waits for a decision, requested as that same agent.
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 1200 && pending.length === 0; i++) {
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
    // 3) The end of the turn was kept going once with the mail.
    expect(shown).toMatch(/live mail for goose/);
  });
});
