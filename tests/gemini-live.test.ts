// Gemini CLI, LIVE: the real `gemini` CLI (its npm package's bundle/gemini.js), installed into a throwaway home by
// `opencadre connect`, driven by a scripted model speaking the Gemini API (GOOGLE_GEMINI_BASE_URL with an API key: no
// Google account), against a real in-process hub. The model is pinned (-m) so Gemini's router, which asks a model for a
// complexity score first, is not in the way; the folder is trusted, since Gemini runs no settings hooks elsewhere.
// Skipped unless OPENCADRE_GEMINI_CLI names bundle/gemini.js (docs/qa/HARNESS-MEASUREMENT.md §3):
//   OPENCADRE_GEMINI_CLI=/path/to/@google/gemini-cli/bundle/gemini.js npx vitest run tests/gemini-live.test.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedGemini } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const GEMINI = process.env.OPENCADRE_GEMINI_CLI;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!GEMINI || !existsSync(GEMINI))("Gemini CLI LIVE: the real CLI, our hooks, a real hub", { timeout: 240_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("GeminiLive");

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Gemini Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:geminilive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-gemini-live-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "gemini"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    // What a user does once: pick API-key auth and trust the project folder.
    const settingsFile = path.join(home, ".gemini", "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    writeFileSync(settingsFile, JSON.stringify({ ...settings, security: { ...settings.security, auth: { selectedType: "gemini-api-key" } } }, null, 2));
    writeFileSync(path.join(home, ".gemini", "trustedFolders.json"), JSON.stringify({ [project]: "TRUST_FOLDER" }));
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    await hub?.close();
  });

  it("one gemini session: its own agent, its risky command held and denied, mail at the end of its turn", async () => {
    const model = await scriptedGemini([
      { tool: /opencadre-session_+set_status$/, args: { task: "live gemini" } },
      { tool: /^run_shell_command$/, args: { command: "rm -rf ./probe-dir", description: "clean" } },
      "done",
    ]);
    try {
      const env = {
        ...childEnv(home),
        PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        GEMINI_API_KEY: "test",
        GOOGLE_GEMINI_BASE_URL: model.url,
        OPENCADRE_GATE_MODE: "ask",
        OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      };
      // --yolo: Gemini's own confirmations are off, so only OpenCadre's gate stands between the model and the command.
      const run = spawn(process.execPath, [GEMINI!, "-p", "Do the task.", "--yolo", "-m", "gemini-2.5-pro"], { cwd: project, env });
      let out = "";
      run.stdout.on("data", (c) => (out += c));
      run.stderr.on("data", (c) => (out += c));
      const exited = new Promise<number | null>((r) => run.on("close", r));

      let agent: string | undefined;
      for (let i = 0; i < 900 && !agent; i++) {
        agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live gemini")?.agentName;
        if (!agent) await new Promise((r) => setTimeout(r, 100));
      }
      expect(agent ?? `NO AGENT\n${out}\n${model.seen.map((s) => s.tools.join(",")).join("\n")}`).toMatch(/^Gemini-GeminiLive-/);
      await fetch(`${hub.url}/v1/messages`, {
        method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
        body: JSON.stringify({ toAgent: agent, body: "live mail for gemini", priority: "high" }),
      });

      const { listApprovals } = await import("../src/approvals.js");
      let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
      for (let i = 0; i < 900 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending, out).toHaveLength(1);
      // Requested as the session's own agent: the gate named it by the session_id Gemini gave the hook.
      expect(pending[0].requested_by_agent_name).toBe(agent);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live gemini test" });

      expect(await exited, out).toBe(0);
      expect(existsSync(path.join(project, "probe-dir", "keep.txt"))).toBe(true);
      const shown = model.seen.map((s) => s.body).join("\n");
      expect(shown).toMatch(/not in the live gemini test/);
      expect(shown).toMatch(/live mail for gemini/);
      expect(shown).toMatch(new RegExp(`You are ${agent}`));
    } finally {
      await model.close();
    }
  });
});
