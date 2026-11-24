import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals } from "../src/approvals.js";
import { listEvents } from "../src/events.js";
import { ALLOW_PROVENANCE, permissionOutput, silenceFor } from "../scripts/opencadre-hook-dialect.mjs";
import { composeGateConfig, GATE_MODES, projectHeaders } from "../scripts/opencadre-config.mjs";
import { gateConfigReport } from "../cli/lib/doctor.mjs";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// F7 / board Q1f (release-blocking), with Codex's ruling corrections (B:\ai-work\temp\049a-q1f-plan-ruling-20260930.md):
// a local policy never stands in for a person's approval. Only a person's decision on the command, or a person-issued
// standing grant, may produce an explicit allow. onTimeout / onHubUnreachable "allow" is NO OPINION (the tool's own
// permission settings decide, which may or may not involve a person), recorded as a `clearance.policy_pass`, never as
// an approval or an execution. A repository's config can tighten the gate but never loosen it. Strict: every outcome
// no person approved is a deny, whatever any local allow says.

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
const scratch = (prefix = "gate-f7-") => mkdtempSync(path.join(tmpdir(), prefix));

// Every client the gate is installed for (GATE_CLIENT_LABELS in the gate).
const CLIENTS = ["claude-code", "codex", "cursor", "opencode", "antigravity", "gemini", "qwen", "amp", "kilo", "cline", "devin", "droid", "crush", "vibe", "grok", "goose", "copilot", "windsurf"] as const;
// The dialects in which an explicit allow can be said at all (the rest are deny-only by design).
const ALLOW_CAPABLE = new Set(["claude-code", "codex", "cursor", "opencode", "qwen", "amp", "kilo", "grok", "copilot"]);

/** Does this printed answer approve the call past the tool's own permission step, in any dialect's words? */
function explicitAllow(out: string): boolean {
  if (!out.trim()) return false;
  let said: Record<string, any>;
  try {
    said = JSON.parse(out);
  } catch {
    return false;
  }
  return [said?.hookSpecificOutput?.permissionDecision, said?.permission, said?.permissionDecision, said?.decision,
    said?.hook_specific_output?.permission_decision].some((v) => v === "allow" || v === "approve");
}

describe("permissionOutput: no dialect prints an explicit allow without person or grant provenance", () => {
  const decisions = ["allow", "deny", "ask", "pass", undefined, ""];
  const provenances: unknown[] = [null, undefined, "", "policy", "timeout", "Person", "PERSON", "byPerson", "client_local_unattested", true, 1, {}, ...ALLOW_PROVENANCE];

  it("holds for every client, decision and provenance (property, exhaustive)", () => {
    let checked = 0;
    for (const client of CLIENTS) {
      for (const decision of decisions) {
        for (const provenance of provenances) {
          for (const byPerson of [undefined, false]) {
            const out = permissionOutput(client, decision as string, "why", { provenance: provenance as string, byPerson: byPerson as boolean });
            const backed = decision === "allow" && ALLOW_PROVENANCE.includes(provenance as string);
            if (explicitAllow(out)) expect(backed, `${client} ${decision} ${String(provenance)}: ${out}`).toBe(true);
            // Anything but a deny or a backed allow is exactly the dialect's no opinion (Cursor: agent_message only).
            if (decision !== "deny" && !backed) {
              expect(out, `${client} ${decision} ${String(provenance)}`).toBe(client === "cursor" ? JSON.stringify({ agent_message: "why" }) : silenceFor(client));
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(CLIENTS.length * decisions.length * provenances.length * 2);
  });

  it("the detector sees an allow: a person's approval or grant IS an explicit allow where the dialect can say one", () => {
    for (const client of CLIENTS) {
      for (const provenance of ALLOW_PROVENANCE) {
        expect(explicitAllow(permissionOutput(client, "allow", "ok", { provenance })), `${client} ${provenance}`).toBe(ALLOW_CAPABLE.has(client));
      }
      // The deny is always said (the detector is not blind to non-allow JSON either).
      expect(explicitAllow(permissionOutput(client, "deny", "no"))).toBe(false);
    }
  });

  it("keeps person and grant provenance apart for OpenCode's adapter", () => {
    for (const provenance of ALLOW_PROVENANCE) {
      expect(JSON.parse(permissionOutput("opencode", "allow", "ok", { provenance })).hookSpecificOutput.opencadreProvenance).toBe(provenance);
    }
    expect(permissionOutput("opencode", "allow", "policy")).toBe("");
  });
});

describe("composeGateConfig: a repository tightens, and composes; it never loosens", () => {
  const RULE_A = { category: "machine-rule", pattern: "\\bmachine-x\\b", risk: "high" };
  const RULE_B = { category: "repo-rule", pattern: "\\brepo-x\\b", risk: "high" };

  it("mode is the stricter of trusted and repository (off < notify < ask < strict), for every pair", () => {
    for (const trusted of GATE_MODES) {
      for (const repo of GATE_MODES) {
        const { cfg, repoIgnored } = composeGateConfig({ home: { mode: trusted }, repo: { mode: repo } });
        const want = GATE_MODES.indexOf(repo) >= GATE_MODES.indexOf(trusted) ? repo : trusted;
        expect(cfg.mode, `${trusted} + repo ${repo}`).toBe(want);
        expect(repoIgnored.length > 0, `${trusted} + repo ${repo}`).toBe(want !== repo);
      }
    }
  });

  it("ignores a repository's attempts to replace or disable rules, lower the mode, or introduce allow, beside a legitimate stricter repository", () => {
    const home = { mode: "ask", rules: [RULE_A], protectedBranches: ["main", "trunk"], onTimeout: "deny", onHubUnreachable: "deny" };
    const { cfg, repoIgnored, warnings } = composeGateConfig({
      home,
      repo: {
        mode: "off", onTimeout: "allow", onHubUnreachable: "allow", useDefaultRules: false, disabledCategories: ["terraform", "machine-rule"],
        allow: [".*"], rules: [RULE_B], protectedBranches: ["release-x"], useDefaultAllowlist: false, waitSeconds: 1,
      },
      env: {},
    });
    expect(cfg.mode).toBe("ask");
    expect(cfg.onTimeout).toBe("deny");
    expect(cfg.onHubUnreachable).toBe("deny");
    expect(cfg.useDefaultRules).toBe(true);
    expect(cfg.disabledCategories).toEqual([]);
    expect(cfg.allow).toEqual([]);
    // Composes: the machine's rules and branches stay, the repository's are added.
    expect(cfg.rules).toEqual([RULE_A, RULE_B]);
    expect(cfg.protectedBranches).toEqual(["main", "trunk", "release-x"]);
    expect(cfg.useDefaultAllowlist).toBe(false);
    expect(cfg.waitSeconds).toBe(540);
    expect(repoIgnored.map((i) => i.key).sort()).toEqual(["allow", "disabledCategories", "mode", "onHubUnreachable", "onTimeout", "useDefaultRules", "waitSeconds"]);
    expect(warnings[0]).toMatch(/^OpenCadre approval gate: ignored .* in this repository's \.opencadre\/approval-gate\.json: a repository's config can tighten the gate, never loosen it\.$/);
  });

  it("a legitimate stricter repository applies in full", () => {
    const { cfg, repoIgnored, warnings } = composeGateConfig({
      home: { mode: "notify", onTimeout: "allow", rules: [RULE_A] },
      repo: { mode: "strict", rules: [RULE_B], onTimeout: "deny", waitSeconds: 900 },
    });
    expect(repoIgnored).toEqual([]);
    expect(cfg).toMatchObject({ mode: "strict", onTimeout: "deny", onHubUnreachable: "deny", rules: [RULE_A, RULE_B], waitSeconds: 900 });
    expect(warnings).toEqual([]);
  });

  it("a repository cannot outrank the user's own looser file or env either way: the stricter side holds", () => {
    // The repository's strict survives a user env of notify (it composes); the user's strict survives a repo's off.
    expect(composeGateConfig({ repo: { mode: "strict" }, env: { OPENCADRE_GATE_MODE: "notify" } }).cfg.mode).toBe("strict");
    expect(composeGateConfig({ repo: { mode: "off" }, env: { OPENCADRE_GATE_MODE: "strict" } }).cfg.mode).toBe("strict");
  });

  it("the trusted layers still honour an allow, as no opinion, and say so", () => {
    for (const layer of ["home", "envFile"] as const) {
      const { cfg, allowKnobs, warnings } = composeGateConfig({ [layer]: { mode: "ask", onTimeout: "allow", onHubUnreachable: "allow" } });
      expect(cfg.onTimeout).toBe("allow");
      expect(allowKnobs.map((k) => k.knob)).toEqual(["onTimeout", "onHubUnreachable"]);
      expect(warnings.at(-1)).toMatch(/unsupported for verified person clearance, so a risky command nobody approves falls back to your tool's own permission settings, never an OpenCadre approval\.$/);
    }
  });

  it("Strict is never loosened: strict from any layer forces both fallbacks to deny", () => {
    const allow = { onTimeout: "allow", onHubUnreachable: "allow" };
    for (const layers of [
      { home: { mode: "strict", ...allow } },
      { envFile: { mode: "strict", ...allow } },
      { home: allow, env: { OPENCADRE_GATE_MODE: "strict" } },
      { home: { mode: "ask", ...allow }, repo: { mode: "strict" } },
    ]) {
      const { cfg, allowKnobs } = composeGateConfig(layers as Parameters<typeof composeGateConfig>[0]);
      expect(cfg.mode).toBe("strict");
      expect([cfg.onTimeout, cfg.onHubUnreachable]).toEqual(["deny", "deny"]);
      expect(allowKnobs).toEqual([]);
    }
  });
});

// --- The gate, end to end, against stub hubs -------------------------------------------------------------------------

type Run = { code: number | null; out: string; err: string };
type StubAnswer = { policy?: string; create?: (res: http.ServerResponse) => void; wait?: (res: http.ServerResponse) => void };

const send = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));

async function stubHub(answer: StubAnswer, port = 0) {
  const policyPasses: Array<Record<string, unknown>> = [];
  const executed: unknown[] = [];
  const approvals: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = () => JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.method === "GET" && url.pathname === "/v1/clearance-policy") return send(res, 200, { policy: { mode: answer.policy ?? "off" } });
    if (req.method === "POST" && url.pathname === "/v1/approvals") {
      approvals.push(body());
      return answer.create ? answer.create(res) : send(res, 201, { approval: { id: "ap1", status: "pending" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/approvals/ap1/wait") {
      return answer.wait ? answer.wait(res) : send(res, 200, { approval: { id: "ap1", status: "pending" } });
    }
    if (req.method === "POST" && url.pathname === "/v1/clearances/policy-pass") {
      policyPasses.push(body());
      return send(res, 200, { outcome: "recorded" });
    }
    if (req.method === "POST" && url.pathname === "/v1/clearances/executed") {
      executed.push(body());
      return send(res, 200, {});
    }
    send(res, 404, { error: "not stubbed" });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    port: (server.address() as AddressInfo).port,
    policyPasses, executed, approvals,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A port nothing listens on (a listener opened and closed again). */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function payload(client: string, command: string, cwd: string, sessionId: string) {
  if (client === "cursor") return { conversation_id: sessionId, generation_id: "g", hook_event_name: "beforeShellExecution", command, cwd, workspace_roots: [cwd] };
  return { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command }, cwd };
}

type GateRun = { client?: string; command?: string; hub: string; key?: string; home: string; cwd?: string; sessionId?: string; env?: Record<string, string>; config?: unknown };

function runGate({ client = "claude-code", command = "terraform apply", hub, key = `agt_${"f".repeat(48)}`, home, cwd, sessionId = "f7-session", env = {}, config }: GateRun): Promise<Run> {
  const dir = cwd ?? scratch("gate-f7-cwd-");
  let configFile = "";
  if (config !== undefined) {
    configFile = path.join(scratch("gate-f7-cfg-"), "gate.json");
    writeFileSync(configFile, JSON.stringify(config));
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--client", client], {
      env: {
        ...process.env, ...GATE_TEST_ENV,
        HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home,
        CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
        OPENCADRE_URL: hub, OPENCADRE_KEY: hub ? key : "",
        OPENCADRE_GATE_MODE: "", OPENCADRE_APPROVER: "", OPENCADRE_APPROVAL_WAIT: "1",
        OPENCADRE_GATE_CONFIG: configFile, OPENCADRE_WAIT_RETRY_MS: "100", OPENCADRE_GATE_WARN: "",
        OPENCADRE_GATE_SHELL: "posix",
        ...env,
      },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload(client, command, dir, sessionId)));
  });
}

const reasonOf = (r: Run) => {
  try {
    return JSON.parse(r.out)?.hookSpecificOutput?.permissionDecisionReason ?? "";
  } catch {
    return "";
  }
};
const queueDir = (home: string) => path.join(home, ".opencadre", "run", "policy-pass");
const queued = (home: string) => (existsSync(queueDir(home)) ? readdirSync(queueDir(home)).filter((n) => n.endsWith(".json")) : []);

// Every path through the gate, with the most permissive local config there is. The property: an explicit allow appears
// ONLY on the person and grant paths, for every client.
const PERMISSIVE = { mode: "ask", onTimeout: "allow", onHubUnreachable: "allow", waitSeconds: 1 };
const PATHS: Record<string, { answer?: StubAnswer; hub?: "dead" | "none"; backed?: boolean; reachableError?: boolean }> = {
  timeout: {},
  expired: { answer: { wait: (res) => send(res, 200, { approval: { id: "ap1", status: "expired" } }) } },
  transport: { hub: "dead" },
  "no hub": { hub: "none" },
  "request refused 400": { answer: { create: (res) => send(res, 400, { error: "bad request" }) }, reachableError: true },
  "request refused 500": { answer: { create: (res) => send(res, 500, { error: "boom" }) }, reachableError: true },
  "unexpected error": { answer: { create: (res) => send(res, 201, "this is not json") }, reachableError: true },
  "approved without a person": { answer: { create: (res) => send(res, 201, { approval: { id: "ap1", status: "approved", decided_by_agent_name: "Bot" } }) } },
  "person approved": { answer: { create: (res) => send(res, 201, { approval: { id: "ap1", status: "approved", decided_by_person_id: "p1", decided_by_person_name: "Pat", decided_via: "console" } }) }, backed: true },
  "grant": { answer: { create: (res) => send(res, 201, { approval: { id: "ap1", status: "approved", decided_by_person_id: "p1", decided_by_person_name: "Pat", decided_via: "grant" } }) }, backed: true },
};

describe("the gate: no explicit allow without person or grant provenance, on any path, in any dialect", { timeout: 120_000 }, () => {
  const stubs: Record<string, Awaited<ReturnType<typeof stubHub>>> = {};
  let dead = "";
  beforeAll(async () => {
    for (const [name, p] of Object.entries(PATHS)) if (!p.hub) stubs[name] = await stubHub(p.answer ?? {});
    dead = `http://127.0.0.1:${await deadPort()}`;
  });
  afterAll(async () => { for (const s of Object.values(stubs)) await s.close(); });

  for (const client of CLIENTS) {
    it.concurrent(client, async () => {
      for (const [name, p] of Object.entries(PATHS)) {
        const hub = p.hub === "dead" ? dead : p.hub === "none" ? "" : stubs[name].url;
        const r = await runGate({ client, hub, home: scratch(), config: PERMISSIVE });
        const where = `${client} / ${name}: code ${r.code} out ${r.out} err ${r.err}`;
        expect(explicitAllow(r.out), where).toBe(Boolean(p.backed) && ALLOW_CAPABLE.has(client));
        if (["claude-code", "codex", "qwen", "grok"].includes(client)) {
          if (p.backed) expect(reasonOf(r), where).toMatch(name === "grant" ? /standing "terraform" grant \(not a new decision on this command\)/ : /^Approved in OpenCadre by Pat$/);
          else if (p.reachableError) expect(reasonOf(r), where).toMatch(/This is an error, not an unreachable hub, so onHubUnreachable does not apply\./);
          else if (name === "approved without a person") expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision, where).toBe("deny");
          else expect(r.out, where).toBe("");
        }
      }
    });
  }

  it("the pre-hook never reports an execution; a policy pass is recorded instead", () => {
    for (const s of Object.values(stubs)) expect(s.executed).toEqual([]);
    for (const pass of [...stubs.timeout.policyPasses, ...stubs.expired.policyPasses]) {
      expect(pass).toMatchObject({ reason: "timeout", delivery: "live", category: "terraform", action: "terraform apply" });
      expect(Object.keys(pass).sort()).toEqual(["action", "approvalId", "category", "client", "delivery", "occurredAt", "project", "reason", "receiptId", "risk"]);
    }
    expect(stubs.timeout.policyPasses).toHaveLength(CLIENTS.length);
  });
});

describe("the gate: cause split of an unreachable hub", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("a real transport failure follows onHubUnreachable: deny by default, no opinion (queued) with \"allow\"", async () => {
    const dead = `http://127.0.0.1:${await deadPort()}`;
    const home = scratch();
    const denied = await runGate({ hub: dead, home, config: { mode: "ask" } });
    expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(denied)).toMatch(/hub unreachable .*blocked \(fail closed\)/);
    expect(queued(home)).toEqual([]);
    const passed = await runGate({ hub: dead, home, config: { mode: "ask", onHubUnreachable: "allow" } });
    expect(passed.out).toBe("");
    expect(passed.err).toMatch(/onHubUnreachable is "allow", so this terraform command goes back to Claude Code's own permission settings, with no OpenCadre approval \(queued for OpenCadre as a policy pass\)\./);
    expect(queued(home)).toHaveLength(1);
  });

  it("with no hub configured, \"allow\" is no opinion and nothing is queued (there is no identity to report as)", async () => {
    const home = scratch();
    const r = await runGate({ hub: "", home, config: { mode: "ask", onHubUnreachable: "allow" } });
    expect(r.out).toBe("");
    expect(r.err).toMatch(/not recorded: no OpenCadre hub or key is configured/);
    expect(queued(home)).toEqual([]);
  });

  it("a refused request after the approver retry is an error too, whatever onHubUnreachable says", async () => {
    const hub = await stubHub({ create: (res) => send(res, 400, { error: "no such approver" }) });
    try {
      const home = scratch();
      const r = await runGate({ hub: hub.url, home, config: { mode: "ask", onHubUnreachable: "allow", approver: "Ghost" } });
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(reasonOf(r)).toMatch(/the approval request was refused \(HTTP 400: no such approver\).*This is an error, not an unreachable hub/);
      expect(hub.approvals).toHaveLength(2);
      expect(queued(home)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("a reachable hub that refuses the request is an error: it denies even with onHubUnreachable \"allow\"", async () => {
    const hub = await stubHub({ create: (res) => send(res, 403, { error: "not allowed here" }) });
    try {
      const home = scratch();
      const r = await runGate({ hub: hub.url, home, config: { mode: "ask", onHubUnreachable: "allow", onTimeout: "allow" } });
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(reasonOf(r)).toMatch(/the approval request was refused \(HTTP 403: not allowed here\).*This is an error, not an unreachable hub/);
      expect(queued(home)).toEqual([]);
      expect(hub.policyPasses).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});

describe("the gate: Strict is never loosened by a local allow", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const allow = { onTimeout: "allow", onHubUnreachable: "allow", waitSeconds: 1 };
  const expectDeny = (r: Run) => {
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision, r.err).toBe("deny");
  };

  it.concurrent("local strict: a timeout and a dead hub both deny", async () => {
    const hub = await stubHub({});
    try {
      expectDeny(await runGate({ hub: hub.url, home: scratch(), config: { mode: "strict", ...allow } }));
      expectDeny(await runGate({ hub: `http://127.0.0.1:${await deadPort()}`, home: scratch(), config: { mode: "strict", ...allow } }));
      expectDeny(await runGate({ hub: hub.url, home: scratch(), config: { mode: "ask", ...allow }, env: { OPENCADRE_GATE_MODE: "strict" } }));
      expect(hub.policyPasses).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it.concurrent("hub policy strict (or ask) with a local ask + allow: the team's rule wins, so the timeout denies", async () => {
    for (const policy of ["strict", "ask"]) {
      const hub = await stubHub({ policy });
      try {
        expectDeny(await runGate({ hub: hub.url, home: scratch(), config: { mode: "ask", ...allow } }));
        expectDeny(await runGate({ hub: hub.url, home: scratch(), config: { mode: "notify", ...allow } }));
        expect(hub.policyPasses).toEqual([]);
      } finally {
        await hub.close();
      }
    }
  });

  it.concurrent("a strict repository beside a home allow denies", async () => {
    const hub = await stubHub({});
    try {
      const home = scratch();
      mkdirSync(path.join(home, ".opencadre"), { recursive: true });
      writeFileSync(path.join(home, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "ask", ...allow }));
      const cwd = scratch();
      mkdirSync(path.join(cwd, ".opencadre"));
      writeFileSync(path.join(cwd, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "strict" }));
      expectDeny(await runGate({ hub: hub.url, home, cwd }));
    } finally {
      await hub.close();
    }
  });
});

describe("the gate: a repository config cannot loosen it", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const repoWith = (config: unknown) => {
    const cwd = scratch("gate-f7-repo-");
    mkdirSync(path.join(cwd, ".opencadre"));
    writeFileSync(path.join(cwd, ".opencadre", "approval-gate.json"), JSON.stringify(config));
    return cwd;
  };
  const homeWith = (config: unknown) => {
    const home = scratch("gate-f7-home-");
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "approval-gate.json"), JSON.stringify(config));
    return home;
  };

  it("replace/disable rules, lower the mode, introduce allow: all ignored, with the warning visible", async () => {
    const hub = await stubHub({});
    try {
      const cwd = repoWith({ mode: "off", onTimeout: "allow", onHubUnreachable: "allow", useDefaultRules: false, disabledCategories: ["terraform"], allow: ["terraform"], rules: [] });
      const r = await runGate({ hub: hub.url, home: homeWith({ mode: "ask" }), cwd });
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(reasonOf(r)).toMatch(/no approval received in 1s/);
      expect(r.err).toMatch(/^OpenCadre approval gate: ignored mode, onTimeout, onHubUnreachable, useDefaultRules, disabledCategories, allow in this repository's \.opencadre\/approval-gate\.json: a repository's config can tighten the gate, never loosen it\.$/m);
      expect(hub.policyPasses).toEqual([]);
      // The same repository beside a dead hub: the repo's onHubUnreachable "allow" is ignored too.
      const down = await runGate({ hub: `http://127.0.0.1:${await deadPort()}`, home: homeWith({ mode: "ask" }), cwd });
      expect(JSON.parse(down.out).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await hub.close();
    }
  });

  it("a legitimate stricter repository applies, and composes with the machine's rules, even beside loosening attempts", async () => {
    const hub = await stubHub({});
    try {
      const cwd = repoWith({ mode: "strict", rules: [{ category: "deploy-x", pattern: "\\bdeploy-x\\b", risk: "high" }], onTimeout: "allow", disabledCategories: ["terraform"] });
      const home = homeWith({ mode: "notify", onTimeout: "allow" });
      for (const command of ["deploy-x now", "terraform apply"]) {
        const r = await runGate({ hub: hub.url, home, cwd, command });
        expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision, `${command}: ${r.err}`).toBe("deny");
      }
      expect(hub.approvals.map((a) => (a as { category: string }).category)).toEqual(["deploy-x", "terraform"]);
      expect(hub.policyPasses).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("the same allow in the user's own file is honoured, as no opinion plus a policy pass plus a warning", async () => {
    const hub = await stubHub({});
    try {
      const r = await runGate({ hub: hub.url, home: homeWith({ mode: "ask", onTimeout: "allow" }) });
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^OpenCadre approval gate: onTimeout "allow" is set; that is unsupported for verified person clearance/m);
      expect(hub.policyPasses).toMatchObject([{ reason: "timeout", delivery: "live" }]);
    } finally {
      await hub.close();
    }
  });
});

describe("the gate: the offline policy-pass queue", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const KEY = `agt_${"k".repeat(48)}`;
  const config = { mode: "ask", onHubUnreachable: "allow" };

  it("is redacted, bound to its chat, sent only by that chat, and deduplicated on replay", async () => {
    const port = await deadPort();
    const hubUrl = `http://127.0.0.1:${port}`;
    const home = scratch();
    const cwd = scratch("gate-f7-proj-");
    // Chat A's command, while the hub is down: no opinion, and a queued record.
    const a = await runGate({ hub: hubUrl, key: KEY, home, cwd, sessionId: "session-A-f7", command: `OPENAI_API_KEY=${SECRET} terraform apply`, config });
    expect(a.out).toBe("");
    const files = queued(home);
    expect(files).toHaveLength(1);
    const text = readFileSync(path.join(queueDir(home), files[0]), "utf8");
    // Redaction: no credential, no unmasked command, no raw session id.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("kkkkkkkk");
    expect(text).not.toContain("session-A-f7");
    const rec = JSON.parse(text);
    expect(rec).toMatchObject({ v: 1, reason: "hub_unreachable", category: "terraform", action: "OPENAI_API_KEY=*** terraform apply", client: "claude-code", attempts: 0 });
    expect(Object.keys(rec.identity).sort()).toEqual(["hub", "keyRef", "projectRef", "sessionRef"]);
    expect(text).not.toContain(cwd.replaceAll("\\", "\\\\"));

    // The hub comes back on the same address.
    const hub = await stubHub({ policy: "off" }, port);
    try {
      // Chat B runs a gated command: it must not deliver A's record under its own identity.
      await runGate({ hub: hubUrl, key: KEY, home, cwd, sessionId: "session-B-f7", command: "terraform plan && terraform apply", config: { mode: "notify" } });
      expect(hub.policyPasses).toEqual([]);
      expect(queued(home)).toHaveLength(1);
      // Chat A comes back: its record is delivered, as queued, under the same receipt id, and removed.
      await runGate({ hub: hubUrl, key: KEY, home, cwd, sessionId: "session-A-f7", command: "terraform apply", config: { mode: "notify" } });
      expect(hub.policyPasses).toEqual([expect.objectContaining({ receiptId: rec.receiptId, reason: "hub_unreachable", delivery: "queued", action: "OPENAI_API_KEY=*** terraform apply" })]);
      expect(queued(home)).toEqual([]);
      // Replay: nothing is left to resend.
      await runGate({ hub: hubUrl, key: KEY, home, cwd, sessionId: "session-A-f7", command: "terraform apply", config: { mode: "notify" } });
      expect(hub.policyPasses).toHaveLength(1);
      expect(hub.executed).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  // Codex review of #680, finding 1: a missing session id used to hash as "", so two runs with no session id were the
  // same "chat". With no session id there is no chat to bind a record to: nothing is queued, and it says so.
  it("with no session id nothing is queued or replayed, and the gate says why", async () => {
    const port = await deadPort();
    const home = scratch();
    const cwd = scratch("gate-f7-proj-");
    const first = await runGate({ hub: `http://127.0.0.1:${port}`, key: KEY, home, cwd, sessionId: "", config });
    expect(first.out).toBe("");
    expect(first.err).toMatch(/not recorded: this chat has no session id, so the record cannot be kept for it/);
    expect(queued(home)).toEqual([]);
    // A record planted as if a session-less run had queued one: another session-less run must not send it.
    const receiptId = randomUUID();
    mkdirSync(queueDir(home), { recursive: true });
    writeFileSync(path.join(queueDir(home), `${receiptId}.json`), JSON.stringify({ v: 1, receiptId, occurredAt: new Date().toISOString(), reason: "hub_unreachable", action: "x", identity: { hub: `http://127.0.0.1:${port}`, keyRef: "k", sessionRef: "s" }, attempts: 0 }));
    const hub = await stubHub({}, port);
    try {
      await runGate({ hub: hub.url, key: KEY, home, cwd, sessionId: "", config: { mode: "notify" } });
      expect(hub.policyPasses).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  // Codex review of #680, finding 2: the same chat (hub, key, session) moved to project B must never deliver project A's
  // record; back in project A it does.
  it("is bound to its project: the same chat in another project does not flush it", async () => {
    const port = await deadPort();
    const hubUrl = `http://127.0.0.1:${port}`;
    const home = scratch();
    const projectA = scratch("gate-f7-projA-");
    const projectB = scratch("gate-f7-projB-");
    expect((await runGate({ hub: hubUrl, key: KEY, home, cwd: projectA, sessionId: "moving-chat", config })).out).toBe("");
    const [file] = queued(home);
    expect(file).toBeDefined();
    const hub = await stubHub({}, port);
    try {
      await runGate({ hub: hubUrl, key: KEY, home, cwd: projectB, sessionId: "moving-chat", config: { mode: "notify" } });
      expect(hub.policyPasses).toEqual([]);
      expect(queued(home)).toEqual([file]);
      await runGate({ hub: hubUrl, key: KEY, home, cwd: projectA, sessionId: "moving-chat", config: { mode: "notify" } });
      expect(hub.policyPasses).toMatchObject([{ receiptId: file.replace(/\.json$/, ""), delivery: "queued" }]);
      expect(queued(home)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("is bound to its project by git remote too: one folder whose origin changes is a different project", async () => {
    const port = await deadPort();
    const hubUrl = `http://127.0.0.1:${port}`;
    const home = scratch();
    const dir = scratch("gate-f7-clone-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/o/project-a.git"], { cwd: dir });
    await runGate({ hub: hubUrl, key: KEY, home, cwd: dir, sessionId: "moving-chat", config });
    expect(queued(home)).toHaveLength(1);
    const hub = await stubHub({}, port);
    try {
      execFileSync("git", ["remote", "set-url", "origin", "https://github.com/o/project-b.git"], { cwd: dir });
      await runGate({ hub: hubUrl, key: KEY, home, cwd: dir, sessionId: "moving-chat", config: { mode: "notify" } });
      expect(hub.policyPasses).toEqual([]);
      execFileSync("git", ["remote", "set-url", "origin", "https://github.com/o/project-a.git"], { cwd: dir });
      await runGate({ hub: hubUrl, key: KEY, home, cwd: dir, sessionId: "moving-chat", config: { mode: "notify" } });
      expect(hub.policyPasses).toMatchObject([{ project: "github.com/o/project-a", delivery: "queued" }]);
    } finally {
      await hub.close();
    }
  });

  it("is bounded: expired and over-retried records are dropped, and it never holds more than 100", async () => {
    const port = await deadPort();
    const home = scratch();
    mkdirSync(queueDir(home), { recursive: true });
    const identity = { hub: "http://elsewhere.test", keyRef: "x", sessionRef: "y" };
    const write = (occurredAt: string, extra: Record<string, unknown> = {}) => {
      const receiptId = randomUUID();
      writeFileSync(path.join(queueDir(home), `${receiptId}.json`), JSON.stringify({ v: 1, receiptId, occurredAt, reason: "timeout", action: "x", identity, attempts: 0, ...extra }));
      return `${receiptId}.json`;
    };
    const expired = write(new Date(Date.now() - 8 * 86_400_000).toISOString());
    const overTried = write(new Date().toISOString(), { attempts: 5 });
    const old = Array.from({ length: 105 }, (_, i) => write(new Date(Date.now() - 86_400_000 + i * 1000).toISOString()));
    writeFileSync(path.join(queueDir(home), "not-a-record.txt"), "left alone");
    await runGate({ hub: `http://127.0.0.1:${port}`, home, config: { mode: "ask", onHubUnreachable: "allow" } });
    const left = queued(home);
    expect(left).toHaveLength(100);
    expect(left).not.toContain(expired);
    expect(left).not.toContain(overTried);
    // The oldest go first; the newest (this run's) stays.
    expect(left).not.toContain(old[0]);
    expect(left).toContain(old[104]);
    expect(existsSync(path.join(queueDir(home), "not-a-record.txt"))).toBe(true);
  });
});

describe("the hub: POST /v1/clearances/policy-pass", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let server: http.Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

  const workspace = (name: string) => {
    const { orgId } = createOrganization(name);
    registerAgent(orgId, "Operator", { role: "operator", system: true });
    const agent = registerAgent(orgId, "Coder");
    return { orgId, key: agent.apiKey };
  };
  const post = async (key: string, body: unknown) => {
    const res = await fetch(`${baseUrl}/v1/clearances/policy-pass`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const events = (orgId: string, type: string) => listEvents(orgId).filter((e) => e.type === type);
  const valid = () => ({ receiptId: randomUUID(), reason: "timeout", action: "terraform apply -var token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", category: "terraform", risk: "high", client: "codex", project: "github.com/o/r", occurredAt: new Date().toISOString(), delivery: "live" });

  it("records a policy pass once per receipt, masked, as handed back (never executed, never a person's decision)", async () => {
    const w = workspace("Policy Pass Replay");
    const body = valid();
    expect(await post(w.key, body)).toEqual({ status: 200, body: { outcome: "recorded" } });
    expect(await post(w.key, { ...body, delivery: "queued" })).toEqual({ status: 200, body: { outcome: "already_recorded" } });
    const passes = events(w.orgId, "clearance.policy_pass");
    expect(passes).toHaveLength(1);
    const p = JSON.parse(passes[0].payload);
    expect(p).toEqual({
      receiptId: body.receiptId, reason: "timeout", outcome: "handed_back", handedBackTo: "client_permission_settings",
      action: "terraform apply -var token=***", category: "terraform", risk: "high", client: "codex", project: "github.com/o/r",
      occurredAt: body.occurredAt, delivery: "live",
    });
    expect(passes[0].payload).not.toMatch(/byPerson|client_local_unattested|executed|approved/);
    expect(events(w.orgId, "clearance.bypassed")).toEqual([]);
    expect(listApprovals(w.orgId)).toEqual([]);
  });

  it("refuses what is not an honest policy pass", async () => {
    const w = workspace("Policy Pass Validation");
    for (const bad of [
      { reason: "approved" }, { reason: undefined }, { receiptId: "x" }, { action: "  " }, { delivery: "executed" },
      { occurredAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }, { occurredAt: "yesterday" },
    ]) {
      expect((await post(w.key, { ...valid(), ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(events(w.orgId, "clearance.policy_pass")).toEqual([]);
  });

  it("a chat with no session yet is an error, not an unreachable hub: it denies even with onHubUnreachable \"allow\"", async () => {
    const { orgId } = createOrganization("Policy Pass No Session");
    const auth = { authorization: `Bearer ${registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey}`, "content-type": "application/json" };
    const { code } = await (await fetch(`${baseUrl}/v1/org/devices`, { method: "POST", headers: auth, body: JSON.stringify({ name: "PC", client: "claude-code" }) })).json();
    const { deviceCredential } = await (await fetch(`${baseUrl}/v1/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json();
    const home = scratch();
    mkdirSync(path.join(home, ".opencadre"));
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: baseUrl, credential: deviceCredential } }));
    writeFileSync(path.join(home, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "ask", onHubUnreachable: "allow", onTimeout: "allow" }));
    const project = projectHeaders(home);
    expect((await fetch(`${baseUrl}/v1/org/projects`, { method: "PUT", headers: auth, body: JSON.stringify({ projectKey: project["x-opencadre-project"], enabled: true }) })).status).toBe(200);
    // No OPENCADRE_URL/KEY: the computer's credential, resolve-only, for a chat the hub has no session for.
    const r = await runGate({ hub: "", home, cwd: home, sessionId: "never-joined" });
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(r)).toMatch(/this chat has no OpenCadre session yet, so this terraform command is blocked \(fail closed\)\. This is an error, not an unreachable hub/);
    expect(queued(home)).toEqual([]);
    expect(events(orgId, "clearance.policy_pass")).toEqual([]);
  });

  it("native denial after the fallthrough: the record says handed back and nothing ran; only a post-tool report could say it ran", async () => {
    const w = workspace("Policy Pass Native Deny");
    const home = scratch();
    const r = await runGate({ hub: baseUrl, key: w.key, home, config: { mode: "ask", onTimeout: "allow", waitSeconds: 1 } });
    expect(r.out).toBe("");
    // The tool's own settings then DENY the command: no post-tool report ever arrives.
    const passes = events(w.orgId, "clearance.policy_pass").map((e) => JSON.parse(e.payload));
    expect(passes).toMatchObject([{ reason: "timeout", outcome: "handed_back", delivery: "live", category: "terraform" }]);
    expect(events(w.orgId, "clearance.bypassed")).toEqual([]);
    expect(listApprovals(w.orgId).map((a) => a.status)).not.toContain("approved");
  });

  it("client death before execution: a queued record is delivered later as a handed-back policy pass, never as an execution", async () => {
    const w = workspace("Policy Pass Client Death");
    const home = scratch();
    const cwd = scratch("gate-f7-proj-");
    // The hub is down while the chat's command is handed back; the tool then dies before running anything.
    const port = await deadPort();
    const down = `http://127.0.0.1:${port}`;
    expect((await runGate({ hub: down, key: w.key, home, cwd, sessionId: "dying-chat", config: { mode: "ask", onHubUnreachable: "allow" } })).out).toBe("");
    expect(queued(home)).toHaveLength(1);
    // The hub returns on the same address; the chat is resumed and its next gated command delivers the record.
    const relay = http.createServer(app);
    await new Promise<void>((resolve) => relay.listen(port, "127.0.0.1", resolve));
    try {
      await runGate({ hub: down, key: w.key, home, cwd, sessionId: "dying-chat", command: "terraform plan", config: { mode: "notify", rules: [{ category: "plan", pattern: "terraform plan", risk: "low" }] } });
    } finally {
      await new Promise<void>((resolve) => { relay.closeAllConnections(); relay.close(() => resolve()); });
    }
    expect(queued(home)).toEqual([]);
    expect(events(w.orgId, "clearance.policy_pass").map((e) => JSON.parse(e.payload))).toMatchObject([{ reason: "hub_unreachable", outcome: "handed_back", delivery: "queued" }]);
    expect(events(w.orgId, "clearance.bypassed")).toEqual([]);
  });
});

// Codex review of #680, finding 3: a repository's ignored values may hold a credential; they are reported by field name
// only, on the gate's stderr and in doctor.
describe("warnings never echo a repository's values", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const PLANTED = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const repoConfig = { mode: `strict-${PLANTED}`, onTimeout: "allow", allow: [`^deploy --token ${PLANTED}$`], disabledCategories: [PLANTED], onHubUnreachable: PLANTED };

  it("composeGateConfig's warning and ignored list carry field names only", () => {
    const { warnings, repoIgnored } = composeGateConfig({ home: { mode: "strict" }, repo: repoConfig });
    expect(JSON.stringify({ warnings, repoIgnored })).not.toContain("ghp_");
    expect(repoIgnored.map((i) => i.key).sort()).toEqual(["allow", "disabledCategories", "mode", "onTimeout"]);
  });

  it("the gate's stderr and doctor's report never contain the planted credential", async () => {
    const hub = await stubHub({});
    try {
      const home = scratch();
      const cwd = scratch("gate-f7-repo-");
      mkdirSync(path.join(cwd, ".opencadre"));
      writeFileSync(path.join(cwd, ".opencadre", "approval-gate.json"), JSON.stringify(repoConfig));
      const r = await runGate({ hub: hub.url, home, cwd, config: { mode: "ask" } });
      expect(r.err).toMatch(/ignored .*allow.* in this repository's/);
      expect(r.err + r.out).not.toContain("ghp_");
      const report = await gateConfigReport({ home, cwd, env: {} });
      const text = report.lines.map((l: { text: string }) => l.text).join("\n");
      expect(text).toMatch(/It tries to loosen the gate/);
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("strict-");
    } finally {
      await hub.close();
    }
  });
});

describe("doctor: the approval gate's config, layer by layer", () => {
  it("warns on an allow, errors on a repository that tries to loosen, and counts queued records", async () => {
    const home = scratch();
    mkdirSync(path.join(home, ".opencadre", "run", "policy-pass"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "ask", onTimeout: "allow" }));
    writeFileSync(path.join(home, ".opencadre", "run", "policy-pass", `${randomUUID()}.json`), "{}");
    const cwd = scratch();
    mkdirSync(path.join(cwd, ".opencadre"));
    writeFileSync(path.join(cwd, ".opencadre", "approval-gate.json"), JSON.stringify({ mode: "off", onHubUnreachable: "allow" }));
    const report = await gateConfigReport({ home, cwd, env: {} });
    expect(report).toMatchObject({ allowFallback: true, repoLoosening: true, queued: 1 });
    const levels = report.lines.map((l: { level: string; text: string }) => `${l.level}: ${l.text}`);
    expect(levels[0]).toMatch(/^amber: Approval gate config ~\/\.opencadre\/approval-gate\.json: mode "ask", onTimeout "allow", onHubUnreachable unset\. onTimeout "allow" is unsupported for verified person clearance/);
    expect(levels[1]).toMatch(/^red: Approval gate config <project>\/\.opencadre\/approval-gate\.json: .* It tries to loosen the gate \(mode, onHubUnreachable\), which is ignored/);
    expect(levels[2]).toMatch(/^amber: Approval gate effective here: mode "ask", onTimeout "allow", onHubUnreachable "deny"/);
    expect(levels[3]).toMatch(/^amber: 1 policy-pass record\(s\) waiting to reach the hub/);
    // No local path is printed.
    expect(levels.join("\n")).not.toContain(home);
  });

  it("says nothing when no layer exists", async () => {
    expect((await gateConfigReport({ home: scratch(), cwd: null, env: {} })).lines).toEqual([]);
  });
});
