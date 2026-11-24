// Antigravity clearance (LAUNCH-CLIENT-GATE.md §1 row 4): the shared approval gate, run as Antigravity runs a
// PreToolUse hook on `run_command`. The payload and answer shapes are Antigravity's documented ones
// (antigravity.google/docs/hooks; the `agy` 1.2.9 hooks.proto, docs/research/HARNESS-ADAPTERS.md §2):
//   in   { toolCall: { name: "run_command", args: { CommandLine, Cwd } }, conversationId, workspacePaths, … }
//   out  { decision: "deny", reason } to block; an EMPTY stdout for everything else, because Antigravity's "allow"
//        approves the call and skips the user's own permission rules, and `agy` 1.2.9 reads `{}` as a DENY.
// MEASURED on `agy` 1.2.9 against a scripted Gemini endpoint (docs/qa/HARNESS-MEASUREMENT.md §10): empty stdout passes,
// `{}` / `{"decision":""}` / a timeout / a non-zero exit / non-JSON all block.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { planAntigravityHooks } from "../cli/lib/antigravity-hooks.mjs";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { decideAsPerson } from "./helpers/person.js";

const GATE = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const payload = (command: string, name = "run_command") => ({
  toolCall: { name, args: { CommandLine: command, Cwd: process.cwd(), WaitMsBeforeAsync: 5000 } },
  stepIdx: 3, conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587", workspacePaths: [process.cwd()],
  transcriptPath: "", artifactDirectoryPath: "", modelName: "gemini-3.6-flash-medium",
});

function runGate(input: unknown, env: Record<string, string>, client = "antigravity", home = mkdtempSync(path.join(tmpdir(), "ag-gate-home-"))): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, "--client", client], {
      env: { ...process.env, ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, OPENCADRE_URL: "", OPENCADRE_KEY: "", CLAUDE_CODE_SESSION_ID: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("the gate, installed for Antigravity", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("holds a risky run_command and answers a deny in Antigravity's own field (strict, no hub: fail closed)", async () => {
    const r = await runGate(payload("rm -rf ./src"), { OPENCADRE_GATE_MODE: "strict" });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/blocked/);
    // Never Claude's nested shape: Antigravity would not read it.
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("says nothing (never `{}`, which agy reads as a deny) for a harmless command, and for any tool that is not run_command", async () => {
    expect((await runGate(payload("git status"), { OPENCADRE_GATE_MODE: "strict" })).out).toBe("");
    // view_file's args carry no CommandLine: the gate has nothing to judge and must not invent a command.
    expect((await runGate(payload("rm -rf ./src", "view_file"), { OPENCADRE_GATE_MODE: "strict" })).out).toBe("");
  });

  it("the Claude Code copy stands down on an Antigravity payload ONLY where Antigravity's own gate is installed", async () => {
    // Without Antigravity's gate, the Claude Code copy (if Antigravity ever runs it) is the only gate there, so it
    // still holds the command: its deny, not silence (review of 7948fb9, B1).
    const bare = await runGate(payload("rm -rf ./src"), { OPENCADRE_GATE_MODE: "strict" }, "claude-code");
    expect(JSON.parse(bare.out).hookSpecificOutput.permissionDecision).toBe("deny");
    const home = mkdtempSync(path.join(tmpdir(), "ag-gate-both-"));
    const plan = planAntigravityHooks({ home, binDir: "/b" });
    mkdirSync(path.dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, plan.after);
    const both = await runGate(payload("rm -rf ./src"), { OPENCADRE_GATE_MODE: "strict" }, "claude-code", home);
    expect(both.out).toBe("");
  });

  it("a person's denial in OpenCadre comes back as decision: deny; an approval comes back as nothing, never Antigravity's allow", async () => {
    const { orgId } = createOrganization("AG Gate Org");
    const requester = registerAgent(orgId, "Antigravity-Gate");
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
    const env = { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: requester.apiKey, OPENCADRE_GATE_MODE: "ask" };
    const { listApprovals } = await import("../src/approvals.js");
    const decideNext = async (decision: "approve" | "deny") => {
      for (let i = 0; i < 100; i++) {
        const [pending] = listApprovals(orgId, { status: "pending" });
        if (pending) {
          expect(pending.requested_by_agent_name).toBe("Antigravity-Gate");
          expect(pending.details).toMatch(/^Antigravity wants to run this shell command/);
          // A clearance is decided by a signed-in PERSON (migration 53): the operator agent's key would be refused.
          const res = await decideAsPerson(baseUrl, orgId, pending.id, { decision, note: decision === "deny" ? "not today" : "fine" });
          expect(res.status).toBe(200);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the gate never asked");
    };

    const denied = runGate(payload("rm -rf ./src"), env);
    await decideNext("deny");
    const d = JSON.parse((await denied).out);
    expect(d).toEqual({ decision: "deny", reason: expect.stringMatching(/denied by Operator: not today/) });

    const approved = runGate(payload("rm -rf ./lib"), env);
    await decideNext("approve");
    expect((await approved).out).toBe("");
  });
});

describe("agy's CLI names no workspace: the folder is the agy process's own, never a file the model can rewrite", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  // MEASURED on agy 1.2.9 (docs/qa/HARNESS-MEASUREMENT.md §10): `workspacePaths: []`, the hook runs in ~/.gemini/config,
  // and agy itself runs in the workspace (agy -> sh -> node gate).
  const cliPayload = (command: string, conversationId: string) => ({ ...payload(command), conversationId, workspacePaths: [] });
  // A project whose own gate config switches clearance off: a pass there proves the gate read THAT folder.
  const offProject = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ag-ws-"));
    mkdirSync(path.join(dir, ".opencadre"), { recursive: true });
    writeFileSync(path.join(dir, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "off" }));
    return dir;
  };
  // OpenCadre set up for this chat (a key for the hub): the fail-closed branch applies only then.
  const configured = () => {
    const { orgId } = createOrganization(`AG CLI ${Math.random()}`);
    return { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: registerAgent(orgId, "Antigravity-CLI").apiKey };
  };
  /** Runs the gate as agy does: a child of `sh -c`, itself started as `agy` in `workspace`. */
  const underAgy = (input: unknown, workspace: string, env: Record<string, string>, home = mkdtempSync(path.join(tmpdir(), "ag-gate-home-"))): Promise<string> => {
    const bin = mkdtempSync(path.join(tmpdir(), "ag-bin-"));
    symlinkSync("/bin/sh", path.join(bin, "agy"));
    return new Promise((resolve) => {
      // `; true` keeps sh alive as the gate's parent (a lone command would be exec'd in its place).
      const child = spawn(path.join(bin, "agy"), ["-c", `"${process.execPath}" "${GATE}" --client antigravity; true`], {
        cwd: workspace,
        env: { ...process.env, ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, CLAUDE_CODE_SESSION_ID: "", ...env },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out));
      child.stdin.end(JSON.stringify(input));
    });
  };

  it.skipIf(process.platform !== "linux")("reads the policy of the folder agy runs in", async () => {
    const project = offProject();
    expect(await underAgy(cliPayload("rm -rf ./src", "conv-a"), project, configured())).toBe("");
  });

  it("blocks a risky command when the folder cannot be found and OpenCadre is set up (never reads ~/.gemini/config)", async () => {
    const r = await runGate(cliPayload("rm -rf ./src", "conv-unknown"), configured());
    const denied = JSON.parse(r.out);
    expect(denied).toMatchObject({ decision: "deny", reason: expect.stringContaining("could not tell which project this Antigravity conversation is in") });
    expect(denied.reason).toContain(process.platform === "win32" ? "agy --add-dir" : "Start agy from the project's folder");
    // A harmless command is not held for it.
    expect((await runGate(cliPayload("git status", "conv-unknown"), configured())).out).toBe("");
  });

  it.skipIf(process.platform !== "linux")("B1 (review of d790104): a forged agy cache or OpenCadre record is ignored where the process tree answers", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "ag-gate-home-"));
    const lax = offProject();
    mkdirSync(path.join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"), JSON.stringify({ [lax]: "conv-forged" }));
    mkdirSync(path.join(home, ".opencadre", "run"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "run", "antigravity-forged.json"), JSON.stringify({ conversationId: "conv-forged", folder: lax }));
    // Not under agy: nothing names the folder, so the command is blocked, not passed by the lax folder's policy.
    expect(JSON.parse((await runGate(cliPayload("rm -rf ./src", "conv-forged"), configured(), "antigravity", home)).out).decision).toBe("deny");
    // Under agy in a strict project: that project's policy, not the forged one.
    const strict = mkdtempSync(path.join(tmpdir(), "ag-strict-"));
    mkdirSync(path.join(strict, ".opencadre"), { recursive: true });
    writeFileSync(path.join(strict, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "strict" }));
    expect(JSON.parse(await underAgy(cliPayload("rm -rf ./src", "conv-forged"), strict, { OPENCADRE_URL: "", OPENCADRE_KEY: "" }, home)).decision).toBe("deny");
  });

  it("holds any command that names those records, a delete or a plain write included", async () => {
    for (const command of ["rm ~/.opencadre/run/antigravity-abc.json", "printf '{}' > ~/.gemini/antigravity-cli/cache/last_conversations.json", "cat ~/.gemini/antigravity-cli/cache/last_conversations.json"]) {
      const r = await runGate(payload(command), { OPENCADRE_GATE_MODE: "strict" });
      expect(JSON.parse(r.out).decision, command).toBe("deny");
    }
  });

  it("where the process tree cannot say (Windows), the folder is unknown: no file decides it (review of 712edc2, S4)", async () => {
    const { antigravityHostWorkspace, antigravityWorkspace } = await import("../scripts/opencadre-config.mjs");
    expect(antigravityHostWorkspace({ platform: "win32" })).toBeNull();
    expect(antigravityWorkspace({ host: null })).toBeNull();
    expect(antigravityWorkspace({ host: { folder: "/w" } })).toBe("/w");
  });

  it("only agy itself counts, never the IDE's helper processes, and a home folder or root is no workspace (review of 712edc2, S3)", async () => {
    const { antigravityHostWorkspace } = await import("../scripts/opencadre-config.mjs");
    const project = offProject();
    const cwdOf = () => project;
    const agy = { pid: 2, line: "/usr/bin/agy -p x", argv: ["/usr/bin/agy", "-p", "x"] };
    expect(antigravityHostWorkspace({ chain: [{ pid: 1, line: "sh -c node gate" }, agy], cwdOf })).toEqual({ folder: project });
    const helper = { pid: 3, line: "/opt/Antigravity/antigravity --type=utility --utility-sub-type=node.mojom.NodeService", argv: ["/opt/Antigravity/antigravity", "--type=utility"] };
    expect(antigravityHostWorkspace({ chain: [helper], cwdOf })).toEqual({ folder: null });
    // A prompt that merely mentions the flag is not a helper (review of 7ffc12c, N5).
    const prompted = { pid: 5, line: "/usr/bin/agy -p fix the --type=x flag", argv: ["/usr/bin/agy", "-p", "fix the --type=x flag"] };
    expect(antigravityHostWorkspace({ chain: [prompted], cwdOf })).toEqual({ folder: project });
    expect(antigravityHostWorkspace({ chain: [{ pid: 4, line: "node /x/agy-wrapper.js", argv: ["node", "/x/agy-wrapper.js"] }], cwdOf })).toEqual({ folder: null });
    const home = mkdtempSync(path.join(tmpdir(), "ag-home-"));
    expect(antigravityHostWorkspace({ chain: [agy], cwdOf: () => home, home })).toEqual({ folder: null });
    expect(antigravityHostWorkspace({ chain: [agy], cwdOf: () => "/" })).toEqual({ folder: null });
  });
});

describe("the policy folder is the session's, never the model's Cwd argument", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("a strict project still holds a command the model points at /tmp", async () => {
    // Review of 8c294fd, finding 1: `toolCall.args.Cwd` is written by the model. Before the fix this command ran
    // under /tmp's (absent) config, i.e. the default notify mode, and was not held.
    const project = mkdtempSync(path.join(tmpdir(), "ag-gate-strict-"));
    mkdirSync(path.join(project, ".opencadre"), { recursive: true });
    writeFileSync(path.join(project, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "strict" }));
    const input = { ...payload("rm -rf /work/A/src"), workspacePaths: [project] };
    input.toolCall.args.Cwd = tmpdir();
    const r = await runGate(input, { OPENCADRE_GATE_MODE: "" });
    expect(JSON.parse(r.out).decision).toBe("deny");
  });
});

describe("connect installs the gate beside the inbox hooks", () => {
  it("writes an opencadre-gate entry on run_command with a 600 s timeout, and keeps a user's disable", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ag-gate-plan-"));
    const plan = planAntigravityHooks({ home, binDir: "/b" });
    const config = JSON.parse(plan.after);
    expect(config["opencadre-gate"]).toEqual({
      enabled: true,
      PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: `node "${path.join("/b", "opencadre-approval-gate.mjs")}" --client antigravity`, timeout: 600 }] }],
    });
    expect(config["opencadre-inbox"].enabled).toBe(true);
    // A user who switched the gate off in Antigravity's Hooks menu keeps it off across a re-run of connect.
    mkdirSync(path.dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, JSON.stringify({ ...config, "opencadre-gate": { ...config["opencadre-gate"], enabled: false } }));
    expect(JSON.parse(planAntigravityHooks({ home, binDir: "/b" }).after)["opencadre-gate"].enabled).toBe(false);
  });
});

describe("doctor --client antigravity reads what connect writes", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const doctor = (home: string): Promise<string> => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "cli", "bin", "opencadre.mjs"), "doctor", "--client", "antigravity", "--home", home], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });

  it("S2 (review of d790104): a named agent only in the legacy file, which agy no longer reads, is named and not trusted", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "ag-legacy-"));
    mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "antigravity", "mcp_config.json"), JSON.stringify({ mcpServers: { opencadre: { serverUrl: "http://h/mcp", headers: { Authorization: "Bearer agt_legacy" } } } }));
    expect(await doctor(home)).toMatch(/Antigravity reads ~\/\.gemini\/config\/mcp_config\.json and ignores that file/);
    const { resolveNamedAgent } = await import("../scripts/opencadre-config.mjs");
    expect(resolveNamedAgent({ client: "antigravity", home, env: {} }).key).toBeUndefined();
  });

  it("finds the session server and both hooks, and says so when the gate is switched off", async () => {
    const { planAntigravitySessionServer } = await import("../cli/lib/device.mjs");
    const home = mkdtempSync(path.join(tmpdir(), "ag-doctor-"));
    for (const plan of [planAntigravitySessionServer({ home, proxyPath: "/b/opencadre-mcp.mjs" }), planAntigravityHooks({ home, binDir: "/b" })]) {
      mkdirSync(path.dirname(plan.file), { recursive: true });
      writeFileSync(plan.file, plan.after);
    }
    const out = await doctor(home);
    expect(out).toMatch(/mcp=configured/);
    expect(out).toMatch(/hooks=present/);
    const plan = planAntigravityHooks({ home, binDir: "/b" });
    const hooks = JSON.parse(plan.after);
    writeFileSync(plan.file, JSON.stringify({ ...hooks, "opencadre-gate": { ...hooks["opencadre-gate"], enabled: false } }));
    expect(await doctor(home)).toMatch(/hooks=partial/);
  });
});
