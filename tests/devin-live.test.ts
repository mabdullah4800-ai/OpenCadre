// Devin CLI, LIVE: the real `devin` (npm @cognition-ai/cli-<platform>), set up in a throwaway home by `opencadre
// connect`, driven over ACP (`devin acp`, as editors and Devin Desktop drive it) by a scripted backend
// (tests/helpers/scripted-devin.ts; no account), against a real in-process hub. Skipped unless OPENCADRE_DEVIN_BIN names
// the binary (docs/qa/HARNESS-MEASUREMENT.md §13):
//   OPENCADRE_DEVIN_BIN=/path/to/devin npx vitest run tests/devin-live.test.ts
// The script: 1) call OpenCadre's set_status through Devin's mcp_call_tool, 2) exec `rm -rf ./probe-dir`, 3) exec a
// harmless `touch`, 4) finish. `devin acp` is launched from ANOTHER folder than the session's, as Devin Desktop does
// (review of 47dab9a, B2). The test decides the held command (deny), sends mail while the session works, reads what
// the model was shown, and checks Devin still ASKED before OpenCadre's tool and the harmless command: OpenCadre never
// answers "allow" for Devin (S4).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childEnv, CLI, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, runNode, startHub, tempDir,
} from "./helpers/device-hub.js";
import { scriptedDevin } from "./helpers/scripted-devin.js";
// A clearance is decided by a signed-in PERSON (migration 53): an operator agent key would be refused.
import { decideAsPerson } from "./helpers/person.js";

const DEVIN = process.env.OPENCADRE_DEVIN_BIN;
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

/** A minimal ACP client: one session in `cwd`, launched from `launchCwd`, one prompt, every permission request recorded
 * in `asked` and answered with its allow option. */
function acpPrompt(bin: string, launchCwd: string, cwd: string, env: Record<string, string>, text: string, children: ChildProcess[], asked: string[]): Promise<string> {
  const child = spawn(bin, ["acp"], { cwd: launchCwd, env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let buf = "";
  let log = "";
  let id = 0;
  const pending = new Map<number, (m: { result?: { sessionId?: string } }) => void>();
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const req = (method: string, params: object) => new Promise<{ result?: { sessionId?: string } }>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    send({ jsonrpc: "2.0", id: i, method, params });
  });
  child.stderr.on("data", (c) => (log += c));
  child.stdout.on("data", (c) => {
    buf += c;
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m: { id?: number; method?: string; params?: { options?: Array<{ kind: string; optionId: string }> } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      log += `${line.slice(0, 500)}\n`;
      if (m.id !== undefined && m.method === "session/request_permission") {
        asked.push(JSON.stringify(m.params));
        const allow = (m.params?.options ?? []).find((o) => /allow/.test(o.kind)) ?? m.params?.options?.[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
      } else if (m.id !== undefined && m.method) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } });
      } else if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
    }
  });
  return (async () => {
    await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const session = await req("session/new", { cwd, mcpServers: [] });
    await req("session/prompt", { sessionId: session.result?.sessionId, prompt: [{ type: "text", text }] });
    child.kill();
    return log;
  })();
}

describe.skipIf(!DEVIN || !existsSync(DEVIN))("Devin LIVE: the real CLI over ACP, our server and hooks, a real hub", { timeout: 300_000 }, () => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let operatorKey: string;
  let orgId: string;
  let deviceId: string;
  let home: string;
  const project = gitProject("DevinLive");
  let backend: Awaited<ReturnType<typeof scriptedDevin>>;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    hub = await startHub();
    const ws = await operatorWorkspace("Devin Live Org");
    operatorKey = ws.operatorKey;
    orgId = ws.orgId;
    await enableProject(hub.url, operatorKey, "local:devinlive");
    const minted = await mintDevice(hub.url, operatorKey, "auto");
    deviceId = minted.deviceId;
    home = tempDir("oc-devin-live-");
    mkdirSync(path.join(home, ".config", "devin"), { recursive: true });
    const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "devin"], childEnv(home, { XDG_CONFIG_HOME: "" }));
    expect(connected.code, connected.err).toBe(0);
    backend = await scriptedDevin([
      { name: "mcp_call_tool", args: { server_name: "opencadre-session", tool_name: "set_status", arguments: { task: "live devin" } } },
      { name: "exec", args: { command: "rm -rf ./probe-dir" } },
      { name: "exec", args: { command: "touch ./harmless.txt" } },
      "done",
    ]);
    mkdirSync(path.join(project, "probe-dir"), { recursive: true });
    writeFileSync(path.join(project, "probe-dir", "keep.txt"), "must survive");
  }, 60_000);

  afterAll(async () => {
    for (const c of children) c.kill("SIGKILL");
    await backend?.close();
    await hub?.close();
  });

  it("one session: its own agent from its stamped calls, its risky command held as that agent and denied, mail at turn end", async () => {
    const env = {
      ...childEnv(home, { XDG_CONFIG_HOME: "" }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TERM: "dumb",
      WINDSURF_API_SERVER_URL: backend.url,
      WINDSURF_API_KEY: "scripted-not-a-key",
      OPENCADRE_GATE_MODE: "ask",
      OPENCADRE_POLICY_TIMEOUT_MS: "20000",
    };
    const asked: string[] = [];
    const done = acpPrompt(DEVIN!, tempDir("oc-devin-launch-"), project, env, "Do the task.", children, asked);

    let agent: string | undefined;
    for (let i = 0; i < 1200 && !agent; i++) {
      agent = ((await liveSessions(hub.url, operatorKey, deviceId)) as Array<{ agentName: string; currentTask?: string }>).find((r) => r.currentTask === "live devin")?.agentName;
      if (!agent) await new Promise((r) => setTimeout(r, 100));
    }
    expect(agent ?? "", `requests: ${backend.seen.length}`).toMatch(/^Devin-DevinLive-/);
    await fetch(`${hub.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: agent, body: "live mail for devin", priority: "high" }),
    });

    const { listApprovals } = await import("../src/approvals.js");
    let pending: Array<{ id: string; requested_by_agent_name: string }> = [];
    for (let i = 0; i < 1200 && pending.length === 0; i++) {
      pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].requested_by_agent_name).toBe(agent);
    await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "not in the live test" });

    const log = await done;
    expect(existsSync(path.join(project, "probe-dir", "keep.txt")), log.slice(-2000)).toBe(true);
    const shown = backend.seen.join("\n");
    expect(shown).toMatch(/denied by Operator: not in the live test/);
    expect(shown).toMatch(/live mail for devin/);
    expect(shown).toMatch(new RegExp(`You are ${agent}`));
    // Devin asked before OpenCadre's tool and before the harmless command, so no hook of ours said "allow".
    expect(existsSync(path.join(project, "harmless.txt"))).toBe(true);
    expect(asked.some((a) => /set_status/.test(a)), asked.join("\n")).toBe(true);
    expect(asked.some((a) => /touch \.\/harmless\.txt/.test(a)), asked.join("\n")).toBe(true);
  });

  it("a risky command typed into a running shell in two writes is held whole (reviews of 3a79037, 8fe0ca9)", { timeout: 120_000 }, async () => {
    mkdirSync(path.join(project, "split-dir"), { recursive: true });
    writeFileSync(path.join(project, "split-dir", "keep.txt"), "must survive");
    // The shell's id is in the result Devin sends back for the `exec` that started it.
    // The LAST match: Devin's own instructions show the phrase too.
    const shellOf = (request: string) => [...request.matchAll(/background with ID: ([0-9a-z]+)/g)].pop()?.[1] ?? "unknown";
    const split = await scriptedDevin([
      { name: "exec", args: { command: "bash --norc --noprofile", tty: true, timeout: 0 } },
      (request) => ({ name: "write_to_process", args: { shell_id: shellOf(request), bytes_input: "r" } }),
      (request) => ({ name: "write_to_process", args: { shell_id: shellOf(request), bytes_input: "m -rf ./split-dir<CR>" } }),
      "done",
    ]);
    try {
      const env = {
        ...childEnv(home, { XDG_CONFIG_HOME: "" }),
        PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        TERM: "dumb",
        WINDSURF_API_SERVER_URL: split.url,
        WINDSURF_API_KEY: "scripted-not-a-key",
        OPENCADRE_GATE_MODE: "ask",
        OPENCADRE_POLICY_TIMEOUT_MS: "20000",
      };
      const done = acpPrompt(DEVIN!, tempDir("oc-devin-launch-"), project, env, "Do the task.", children, []);
      // The joined line is held for approval as the session's agent; the test denies it.
      const { listApprovals } = await import("../src/approvals.js");
      let pending: Array<{ id: string; details: string }> = [];
      for (let i = 0; i < 600 && pending.length === 0; i++) {
        pending = listApprovals(orgId, { status: "pending" }) as typeof pending;
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pending, `requests: ${split.seen.length}`).toHaveLength(1);
      expect(pending[0].details).toMatch(/rule: rm-rf/);
      await decideAsPerson(hub.url, orgId, pending[0].id, { decision: "deny", note: "split write" });
      const log = await done;
      await new Promise((r) => setTimeout(r, 1000));
      expect(split.seen.length, "Devin asked for every step").toBeGreaterThanOrEqual(4);
      expect(existsSync(path.join(project, "split-dir", "keep.txt")), log.slice(-3000)).toBe(true);
      expect(split.seen.join("\n")).toMatch(/denied by Operator: split write/);
    } finally {
      await split.close();
    }
  });
});
