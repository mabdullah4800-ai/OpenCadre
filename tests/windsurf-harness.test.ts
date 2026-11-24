// Windsurf / Devin Desktop (Cascade): clearance only, driven the way its documented hooks run
// (docs.devin.ai/desktop/cascade/hooks, read 2026-09-24): ~/.codeium/windsurf/hooks.json, a `pre_run_command` hook given
// { agent_action_name, trajectory_id, execution_id, timestamp, model_name, tool_info: { command_line, cwd } } on stdin,
// which blocks the command by exiting 2 with its reason on stderr; its stdout is not read.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir, WORD_NAME, sessionNamed,
} from "./helpers/device-hub.js";
import { GATE_TEST_ENV } from "./helpers/spawn.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

/** Runs a hook as Windsurf does: in the workspace root (a hook's default `working_directory`). `nodeArgs` go before the
 * script; `hold` keeps stdin open after the payload, so the hook is still running when something else happens. */
function runHook(script: string, args: string[], payload: unknown, env: Record<string, string>, { cwd, nodeArgs = [], hold = false }: { cwd?: string; nodeArgs?: string[]; hold?: boolean } = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, script, ...args], { env, ...(cwd ? { cwd } : {}) });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
    if (hold) child.stdin.write(JSON.stringify(payload));
    else child.stdin.end(JSON.stringify(payload));
  });
}

describe("Windsurf, installed by connect, against a real hub", { timeout: 120_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  let bin: string;
  const project = gitProject("SurfProj");

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Windsurf Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:surfproj");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-windsurf-e2e-");
    // A user's own hook, which connect must keep.
    mkdirSync(path.join(home, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(path.join(home, ".codeium", "windsurf", "hooks.json"), JSON.stringify({ hooks: { pre_run_command: [{ command: "my-audit.sh", show_output: true }] } }));
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "windsurf"], childEnv(home));
    expect(connected.code, connected.err).toBe(0);
    bin = path.join(home, ".opencadre", "bin");
  }, 60_000);

  afterAll(async () => {
    await hub.close();
  });

  const payload = (trajectory: string, command: string) => ({
    agent_action_name: "pre_run_command", trajectory_id: trajectory, execution_id: "e1", timestamp: new Date().toISOString(), model_name: "m",
    tool_info: { command_line: command, cwd: project },
  });
  const gate = (body: object, extra: Record<string, string> = {}, opts: { nodeArgs?: string[]; hold?: boolean; dir?: string } = {}) =>
    runHook(path.join(opts.dir ?? bin, "opencadre-approval-gate-loader.mjs"), ["--client", "windsurf"], body, childEnv(home, extra), { cwd: project, ...opts });

  it("connect added the gate beside the user's own hook, and nothing else", () => {
    const hooks = JSON.parse(readFileSync(path.join(home, ".codeium", "windsurf", "hooks.json"), "utf8")).hooks.pre_run_command;
    expect(hooks[0]).toEqual({ command: "my-audit.sh", show_output: true });
    // Through the loader, so a gate that cannot load blocks instead of exiting 1 (which Windsurf treats as "run it").
    expect(hooks[1]).toEqual({ command: `node "${path.join(bin, "opencadre-approval-gate-loader.mjs")}" --client windsurf`, powershell: `node "${path.join(bin, "opencadre-approval-gate-loader.mjs")}" --client windsurf`, show_output: false });
  });

  it("a harmless command exits 0 and says nothing, and adds no agent", async () => {
    const r = await gate(payload("traj-1", "git status"), { OPENCADRE_GATE_MODE: "ask" });
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({ code: 0, out: "", err: "" });
    expect(await liveSessions(hub.url, operatorKey, deviceId)).toEqual([]);
  });

  it("CLEARANCE: a risky command is held as its conversation's own agent, and a denial exits 2 with the reason on stderr", async () => {
    const run = gate(payload("traj-1", "rm -rf ./src"), { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/^Windsurf wants to run this shell command in .*SurfProj/);
    expect(pending[0].requested_by_agent_name).toMatch(WORD_NAME);
    expect(await sessionNamed(hub.url, operatorKey, pending[0].requested_by_agent_name)).toMatchObject({ tool: "windsurf", projectName: "SurfProj" });
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    const r = await run;
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/denied by Operator: no/);
  });

  it("B1: the policy folder is the workspace, never the model-written tool_info.cwd", async () => {
    // A model told to run a delete in the enabled project, with its Cwd argument pointing at a folder of no project.
    const elsewhere = tempDir("oc-windsurf-elsewhere-");
    const run = gate({ ...payload("traj-2", `rm -rf ${project}/src`), tool_info: { command_line: `rm -rf ${project}/src`, cwd: elsewhere } }, { ...GATE_TEST_ENV, OPENCADRE_GATE_MODE: "ask" });
    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; details: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].details).toMatch(/SurfProj/);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "no" });
    expect((await run).code).toBe(2);
  });

  it("S1: a pre_run_command whose command cannot be read is blocked, not passed", async () => {
    const r = await gate({ agent_action_name: "pre_run_command", trajectory_id: "traj-3", command_line: "rm -rf ./src" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read this shell command/);
  });

  it("S2: a gate that crashes blocks the command (Windsurf runs it on any exit but 2)", async () => {
    // A throw from outside any handler while the gate is still reading its input.
    const r = await gate(payload("traj-4", "git status"), {}, { nodeArgs: ["--import", "data:text/javascript,setTimeout(()=>{throw new Error('boom')},300)"], hold: true });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/OpenCadre approval gate failed \(boom\), so this command was blocked/);
  });

  it("S3 (review of 0610cda): a gate that cannot LOAD blocks too (a helper missing after a partial upgrade)", async () => {
    const partial = tempDir("oc-windsurf-partial-");
    cpSync(bin, partial, { recursive: true });
    // The helper lives in the active generation (Q1g PR-2); a generation missing one is the partial install.
    rmSync(path.join(partial, ".gen", readFileSync(path.join(partial, ".gen", "current"), "utf8").trim(), "opencadre-secrets.mjs"));
    const r = await gate(payload("traj-5", "git status"), {}, { dir: partial });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/OpenCadre approval gate could not load/);
  });

  it("S3: input it cannot parse blocks the command", async () => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(bin, "opencadre-approval-gate-loader.mjs"), "--client", "windsurf"], { env: childEnv(home), cwd: project });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code, err }));
      child.stdin.end("{not json");
    });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read this hook's input/);
  });

  it("doctor --client windsurf finds the gate, prints no session-server line, and says what the gate does", async () => {
    const r = await runNode(CLI, ["doctor", "--client", "windsurf", "--home", home], childEnv(home));
    expect(r.out).toMatch(/hooks=present/);
    expect(r.out).toMatch(/mcp=none\(gate-only\)/);
    expect(r.out).not.toMatch(/mcp_config\.json/);
    expect(r.out).not.toMatch(/joins as its own agent/);
    expect(r.out).toMatch(/Approval gate installed: risky shell commands in Windsurf wait for approval in OpenCadre/);
    expect(r.code).toBe(0);
  });

  it("S4 (review of 0610cda): doctor does not call a gate-only install healthy while its helpers don't match", async () => {
    // A helper of the gate's closure gone from the active generation (Q1g PR-2): the install is partial.
    const file = path.join(bin, ".gen", readFileSync(path.join(bin, ".gen", "current"), "utf8").trim(), "opencadre-secrets.mjs");
    const text = readFileSync(file, "utf8");
    rmSync(file);
    try {
      const r = await runNode(CLI, ["doctor", "--client", "windsurf", "--home", home], childEnv(home));
      expect(r.out).toMatch(/verdict=helpers_mismatch/);
      expect(r.out).not.toMatch(/Approval gate installed: risky/);
      expect(r.code).not.toBe(0);
    } finally {
      writeFileSync(file, text);
    }
  });

  it("connect does not promise Windsurf chats join OpenCadre", async () => {
    const r = await runNode(CLI, ["connect", "--home", home, "--client", "windsurf"], childEnv(home));
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/Restart Windsurf/);
    expect(r.out).toMatch(/Devin Local agent does not run Cascade hooks/);
  });
});
