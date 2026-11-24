// Qwen Code, LIVE: the real `qwen` CLI (its npm package's cli-entry.js), installed into a throwaway home by
// `opencadre connect`, driven by a scripted OpenAI-compatible model (Qwen's `--auth-type openai` with OPENAI_BASE_URL:
// no account), against a real in-process hub. It exercises what payload tests cannot: Qwen's real process tree
// (cli-entry → cli.js → the proxy, hooks under `bash -c`), which the proxy's host lookup and the hooks' `$PPID` rely on.
// Skipped unless OPENCADRE_QWEN_CLI names cli-entry.js (docs/qa/HARNESS-MEASUREMENT.md §5):
//   OPENCADRE_QWEN_CLI=/path/to/@qwen-code/qwen-code/cli-entry.js npx vitest run tests/qwen-live.test.ts
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

const QWEN = process.env.OPENCADRE_QWEN_CLI;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!QWEN || !existsSync(QWEN) || process.platform === "win32")("Qwen Code LIVE: the real CLI, our hooks, a real hub", { timeout: 240_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("QwenLive");

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Qwen Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:qwenlive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-qwen-live-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "qwen"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await hub?.close();
  });

  it("one qwen process: its own agent, its risky command held and denied, mail at the end of its turn", async () => {
    const model = await scriptedModel([
      { tool: /^mcp__opencadre-session__set_status$|opencadre.*set_status/, args: { task: "live qwen" } },
      { tool: /^run_shell_command$/, args: { command: "rm -rf ./probe-dir", description: "clean" } },
      "done",
    ]);
    try {
      const env = {
        ...childEnv(home),
        PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        OPENAI_API_KEY: "test",
        OPENAI_BASE_URL: model.url,
        OPENAI_MODEL: "test-model",
        QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
        OPENCADRE_GATE_MODE: "ask",
        OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      };
      // yolo: Qwen's own confirmations are off, so only OpenCadre's gate stands between the model and the command.
      const run = spawn(process.execPath, [QWEN!, "-p", "Do the task.", "--auth-type", "openai", "--approval-mode", "yolo"], { cwd: project, env });
      let out = "";
      run.stdout.on("data", (c) => (out += c));
      run.stderr.on("data", (c) => (out += c));
      const exited = new Promise<number | null>((r) => run.on("close", r));

      let agent: string | undefined;
      for (let i = 0; i < 900 && !agent; i++) {
        agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live qwen")?.agentName;
        if (!agent) await new Promise((r) => setTimeout(r, 100));
      }
      expect(agent ?? `NO AGENT\n${out}\n${model.seen.map((s) => s.tools.join(",")).join("\n")}`).toMatch(/^Qwen-QwenLive-/);
      await fetch(`${hub.url}/v1/messages`, {
        method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
        body: JSON.stringify({ toAgent: agent, body: "live mail for qwen", priority: "high" }),
      });

      const { listApprovals } = await import("../src/approvals.js");
      let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
      for (let i = 0; i < 900 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending, out).toHaveLength(1);
      // Requested as the process's own agent: the hook found the seat through Qwen's real process tree.
      expect(pending[0].requested_by_agent_name).toBe(agent);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live qwen test" });

      expect(await exited, out).toBe(0);
      expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
      const shown = model.seen.map((s) => s.body).join("\n");
      expect(shown).toMatch(/not in the live qwen test/);
      expect(shown).toMatch(/live mail for qwen/);
      expect(shown).toMatch(new RegExp(`You are ${agent}`));
    } finally {
      await model.close();
    }
  });
});
