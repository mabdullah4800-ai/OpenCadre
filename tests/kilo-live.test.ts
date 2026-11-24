// Kilo Code's CLI, LIVE: the real `kilo` binary, set up in a throwaway home by `opencadre connect`, driven by a scripted
// model (an OpenAI-compatible provider in its config; no Kilo account), against a real in-process hub. Kilo runs as
// `kilo serve` with `kilo run --attach` sending the prompt, so it stays up after the turn, as the TUI does. Skipped unless
// OPENCADRE_KILO_BIN names the binary (docs/qa/HARNESS-MEASUREMENT.md §9), so the suite never depends on a 170 MB
// download; run it whenever the adapter or Kilo changes:
//   OPENCADRE_KILO_BIN=/path/to/kilo npx vitest run tests/kilo-live.test.ts
// The script: 1) call OpenCadre's set_status, 2) run `rm -rf ./probe-dir` in bash, 3) finish. The test decides the held
// command (deny), sends mail while the session works, and reads what the model was shown.
import { type ChildProcess, spawn } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedModel } from "./helpers/scripted-model.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const KILO = process.env.OPENCADRE_KILO_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

describe.skipIf(!KILO || !existsSync(KILO))("Kilo Code LIVE: the real binary, our plugin, a real hub", { timeout: 240_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("KiloLive");
  let model: Awaited<ReturnType<typeof scriptedModel>>;
  const servers: ChildProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Kilo Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:kilolive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-kilo-live-");
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "kilo"], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(connected.code, connected.err).toBe(0);
    model = await scriptedModel([
      { tool: /^opencadre-session_set_status$/, args: { task: "live kilo" } },
      { tool: /^bash$/, args: { command: "rm -rf ./probe-dir", description: "clean" } },
      "done",
    ]);
    // The user's side of the setup: a model to talk to, and bash allowed without asking (so only OpenCadre holds it).
    const file = path.join(home, ".config", "kilo", "kilo.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({
      ...config,
      provider: { scripted: { npm: "@ai-sdk/openai-compatible", options: { baseURL: model.url, apiKey: "test" }, models: { "test-model": { tool_call: true } } } },
      model: "scripted/test-model",
      permission: { bash: "allow" },
    }, null, 2));
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    for (const s of servers) s.kill();
    await model?.close();
    await hub?.close();
  });

  it("one session: its own agent, its risky command held and denied, mail delivered when it goes idle, and an idle session woken by new mail", async () => {
    const env = {
      ...childEnv(home, { XDG_CONFIG_HOME: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_TELEMETRY_LEVEL: "off",
      KILO_NO_DAEMON: "1",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      // Kilo takes its folder from PWD before its working directory (measured: a stale PWD named the wrong project). A
      // shell always sets it; a test spawning Kilo directly must too.
      PWD: project,
    };
    // A long-lived Kilo, as the TUI is (`kilo run` alone exits the moment its session goes idle), and one prompt sent to
    // it the way the TUI sends one.
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const { port: p } = s.address() as AddressInfo;
        s.close(() => resolve(p));
      });
    });
    const server = spawn(KILO!, ["serve", "--port", String(port)], { cwd: project, env });
    let out = "";
    server.stdout.on("data", (c) => (out += c));
    server.stderr.on("data", (c) => (out += c));
    servers.push(server);
    for (let i = 0; i < 300; i++) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const run = spawn(KILO!, ["run", "--attach", `http://127.0.0.1:${port}`, "--dir", project, "--format", "json", "Do the task."], { cwd: project, env });
    run.stdout.on("data", (c) => (out += c));
    run.stderr.on("data", (c) => (out += c));
    const exited = new Promise<number | null>((r) => run.on("close", r));

    // 1) The session's set_status lands on an agent of its own.
    let agent: string | undefined;
    for (let i = 0; i < 600 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live kilo")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent, out).toMatch(/^Kilo-KiloLive-/);
    // Mail while it works: it must reach the session when it goes idle.
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for kilo", priority: "high" }),
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
    // 3) Going idle with unread mail started one more turn in the running Kilo, with the notice as its prompt.
    for (let i = 0; i < 300 && !model.seen.some((s) => /live mail for kilo/.test(s.body)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(model.seen.map((s) => s.body).join("\n"), out).toMatch(/You have 1 unread OpenCadre message\(s\)[\s\S]*live mail for kilo/);
    // 4) IDLE WAKE: mail that arrives while the session sits idle starts a turn too, naming only the new mail.
    const seenBefore = model.seen.length;
    await new Promise((r) => setTimeout(r, 1000));
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "second live mail, sent while idle", priority: "high" }),
    });
    for (let i = 0; i < 300 && !model.seen.slice(seenBefore).some((s) => /second live mail/.test(s.body)); i++) await new Promise((r) => setTimeout(r, 100));
    const woke = model.seen.slice(seenBefore).find((s) => /second live mail/.test(s.body));
    expect(woke, out).toBeDefined();
  });
});
