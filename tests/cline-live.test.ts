// Cline's CLI, LIVE: the real `cline` (npm `cline`), set up in a throwaway home by `opencadre connect`, driven by a
// scripted model through Cline's own OpenAI-compatible provider (`cline auth -p openai-compatible`; no account), against
// a real in-process hub. Skipped unless OPENCADRE_CLINE_BIN names the CLI's `bin/cline` (docs/qa/HARNESS-MEASUREMENT.md
// §11):
//   OPENCADRE_CLINE_BIN=/path/to/node_modules/cline/bin/cline npx vitest run tests/cline-live.test.ts
// Cline runs its sessions inside a local hub daemon it starts on first use; the test gives it a port of its own
// (CLINE_HUB_PORT) and stops it afterwards. The script: 1) call OpenCadre's set_status, 2) run `rm -rf ./probe-dir`,
// 3) finish. The test decides the held command (deny), and reads what the model was shown.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedModel } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const CLINE = process.env.OPENCADRE_CLINE_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  });
});

describe.skipIf(!CLINE || !existsSync(CLINE))("Cline LIVE: the real CLI, our hooks and server, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let hubPort: number;
  const project = gitProject("ClineLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  let env: Record<string, string>;

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Cline Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:clinelive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-cline-live-");
    hubPort = await freePort();
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "cline"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedModel([
      { tool: /^opencadre-session__set_status$/, args: { task: "live cline" } },
      { tool: /^run_commands$/, args: { commands: ["rm -rf ./probe-dir"] } },
      "done",
    ]);
    env = {
      ...childEnv(home),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PWD: project,
      CLINE_HUB_PORT: String(hubPort),
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    // The user's side: a model to talk to.
    execFileSync(process.execPath, [CLINE!, "auth", "-p", "openai-compatible", "-k", "scripted", "-b", model.url, "-m", "test-model"], { env, cwd: project, stdio: "ignore", timeout: 60_000 });
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 120_000);

  afterAll(async () => {
    // The hub daemon this test's Cline started, found by its own port.
    try {
      for (const line of execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")) {
        if (line.includes("--cline-hub-daemon") && line.includes(`--port ${hubPort} `)) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
      }
    } catch { /* already gone */ }
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent from its stamped calls, its risky command held as that agent and denied, and told why", async () => {
    const run = spawn(process.execPath, [CLINE!, "--json", "-c", project, "Do the task."], { cwd: project, env });
    let out = "";
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live cline")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent, `${out}\nTOOLS: ${[...new Set(model.seen.flatMap((s) => s.tools))].join(",")}`).toMatch(/^Cline-ClineLive-/);

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
    expect(shown).toMatch(/OpenCadre blocked this command, it was NOT run/);
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    // Told its name at its first tool result (Cline's start and prompt hooks cannot answer).
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
  });
});
