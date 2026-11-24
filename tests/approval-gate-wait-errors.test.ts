import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// Codex ruling F6: a failed wait for a decision is an ERROR, never a timeout. Before this, any 4xx from
// GET /v1/approvals/:id/wait other than 429 broke the wait loop and fell into the TIMEOUT branch, so under a local
// `onTimeout: "allow"` a 404 (or a revoked key's 401) ALLOWED the command nobody approved. Every error now fails
// closed, whatever onTimeout says, and says it failed rather than that nobody answered. Only a genuine timeout -- the
// hub kept answering "still pending" until the deadline -- is governed by onTimeout.
//
// A stub hub, not the real one: the subject is the gate's reaction to what /wait answers, which a real hub cannot be
// made to answer on demand (a 409, a malformed body, a hub that fails until the deadline). The stub answers the policy
// read with mode "off", so the LOCAL config (mode ask, with the onTimeout under test) is what holds the command.

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
const COMMAND = "terraform apply";
const WAIT_SECONDS = 1;

type WaitAnswer = (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void;

async function stubHub(onWait: WaitAnswer) {
  let waits = 0;
  const executed: unknown[] = [];
  const policyPasses: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && url.pathname === "/v1/clearance-policy") return json(200, { policy: { mode: "off" } });
    if (req.method === "POST" && url.pathname === "/v1/approvals") return json(201, { approval: { id: "ap1", status: "pending" } });
    if (req.method === "POST" && url.pathname === "/v1/clearances/executed") {
      executed.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      return json(200, {});
    }
    if (req.method === "POST" && url.pathname === "/v1/clearances/policy-pass") {
      policyPasses.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      return json(200, { outcome: "recorded" });
    }
    if (req.method === "GET" && url.pathname === "/v1/approvals/ap1/wait") return onWait(++waits, req, res);
    json(404, { error: "not stubbed" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    waits: () => waits,
    executed,
    policyPasses,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const CLIENTS = ["claude-code", "codex", "cursor"] as const;
type Client = (typeof CLIENTS)[number];

function payload(client: Client, cwd: string) {
  if (client === "cursor") {
    return { conversation_id: "conv-f6", generation_id: "g", hook_event_name: "beforeShellExecution", command: COMMAND, cwd, workspace_roots: [cwd] };
  }
  return { hook_event_name: "PreToolUse", session_id: "f6", tool_name: "Bash", tool_input: { command: COMMAND }, cwd };
}

type Run = { code: number | null; out: string; err: string };

function runGate(client: Client, hub: string, onTimeout: "allow" | "deny"): Promise<Run> {
  const cwd = mkdtempSync(path.join(tmpdir(), "gate-f6-"));
  const cfg = path.join(cwd, "gate.json");
  writeFileSync(cfg, JSON.stringify({ mode: "ask", onTimeout, onHubUnreachable: "deny", waitSeconds: WAIT_SECONDS }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--client", client], {
      env: {
        ...process.env, ...GATE_TEST_ENV,
        HOME: cwd, USERPROFILE: cwd, OPENCADRE_HOOK_HOME: cwd,
        CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
        OPENCADRE_URL: hub, OPENCADRE_KEY: `agt_${"f".repeat(48)}`,
        OPENCADRE_GATE_MODE: "", OPENCADRE_APPROVER: "", OPENCADRE_APPROVAL_WAIT: "",
        OPENCADRE_GATE_CONFIG: cfg, OPENCADRE_WAIT_RETRY_MS: "100",
      },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload(client, cwd)));
  });
}

/** The exact answer each dialect gives, with the reason matched by `reason`. */
function expectDeny(client: Client, r: Run, reason: RegExp) {
  expect(r.code, `stderr: ${r.err}`).toBe(0);
  const said = JSON.parse(r.out);
  if (client === "cursor") {
    expect(said).toEqual({ permission: "deny", user_message: expect.stringMatching(reason), agent_message: expect.stringMatching(reason) });
  } else {
    expect(said).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(reason) } });
  }
  expect(r.out).not.toMatch(/"allow"/);
}

/** A deny that is an ERROR: it names the failure, and never reads as "nobody answered". */
function expectErrorDeny(client: Client, r: Run, why: RegExp) {
  expectDeny(client, r, /waiting for the decision on this terraform command failed \(.*\), so it is blocked \(fail closed\)\. This is an error, not a timeout\./);
  const reason = client === "cursor" ? JSON.parse(r.out).user_message : JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
  expect(reason).toMatch(why);
  expect(reason).not.toMatch(/no approval received|no decision in|timed out/);
  expect(r.err).toMatch(/waiting for approval ap1 failed/);
  expect(r.err).toMatch(why);
}

const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const pending = (res: http.ServerResponse) => json(res, 200, { approval: { id: "ap1", status: "pending" } });

describe.each(CLIENTS)("approval gate /wait errors fail closed: %s", { timeout: SPAWN_TEST_TIMEOUT_MS }, (client) => {
  // 4xx: the wait ends at once, with the status, and never allows -- under onTimeout "allow" above all.
  for (const status of [400, 401, 403, 404, 409]) {
    it.concurrent(`HTTP ${status} denies as an error, even with onTimeout "allow"`, async () => {
      const hub = await stubHub((_n, _req, res) => json(res, status, { error: `stub ${status}` }));
      try {
        for (const onTimeout of ["allow", "deny"] as const) {
          const r = await runGate(client, hub.url, onTimeout);
          expectErrorDeny(client, r, new RegExp(`HTTP ${status}: stub ${status}`));
        }
        // Not retried: one wait per run.
        expect(hub.waits()).toBe(2);
        expect(hub.executed).toEqual([]);
      } finally {
        await hub.close();
      }
    });
  }

  // 5xx and 429 are retried until the deadline; still failing then is an error, not a timeout.
  for (const status of [500, 503, 429]) {
    it.concurrent(`HTTP ${status} is retried, then denies as an error at the deadline, even with onTimeout "allow"`, async () => {
      const hub = await stubHub((_n, _req, res) => json(res, status, { error: "busy" }));
      try {
        const r = await runGate(client, hub.url, "allow");
        expectErrorDeny(client, r, new RegExp(`HTTP ${status}, still failing when the ${WAIT_SECONDS}s wait ran out`));
        expect(hub.waits()).toBeGreaterThan(1);
        expect(hub.executed).toEqual([]);
      } finally {
        await hub.close();
      }
    });
  }

  it.concurrent(`a network failure is retried, then denies as an error at the deadline, even with onTimeout "allow"`, async () => {
    const hub = await stubHub((_n, req) => req.socket.destroy());
    try {
      const r = await runGate(client, hub.url, "allow");
      expectErrorDeny(client, r, new RegExp(`network error: .+, still failing when the ${WAIT_SECONDS}s wait ran out`));
      expect(hub.waits()).toBeGreaterThan(1);
      expect(hub.executed).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  const malformed: Array<[string, (res: http.ServerResponse) => void]> = [
    ["a non-JSON body", (res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>proxy</html>")],
    ["JSON with no approval", (res) => json(res, 200, { ok: true })],
    ["an unknown status", (res) => json(res, 200, { approval: { id: "ap1", status: "cancelled" } })],
  ];
  for (const [what, answer] of malformed) {
    it.concurrent(`${what} denies as a malformed response, even with onTimeout "allow"`, async () => {
      const hub = await stubHub((_n, _req, res) => answer(res));
      try {
        const r = await runGate(client, hub.url, "allow");
        expectErrorDeny(client, r, /HTTP 200, malformed response/);
        expect(hub.waits()).toBe(1);
        expect(hub.executed).toEqual([]);
      } finally {
        await hub.close();
      }
    });
  }

  // Unchanged: a genuine timeout is what onTimeout governs.
  it.concurrent(`a genuine pending timeout denies under onTimeout "deny"`, async () => {
    const hub = await stubHub((_n, _req, res) => pending(res));
    try {
      const r = await runGate(client, hub.url, "deny");
      expectDeny(client, r, new RegExp(`^OpenCadre approval gate: no approval received in ${WAIT_SECONDS}s \\(pending\\)\\. Do not retry`));
      expect(hub.executed).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  // F7 / Q1f (flipped): a genuine timeout under onTimeout "allow" used to print an explicit allow (Cursor excepted) and
  // report the command as EXECUTED from the pre-hook. It is now no opinion in every dialect, and a policy pass is recorded
  // instead (POST /v1/clearances/policy-pass), never /v1/clearances/executed: the tool may still deny or never run it.
  const handedBack = (clientName: string) => new RegExp(`^OpenCadre approval gate: no decision in ${WAIT_SECONDS}s; onTimeout is "allow", so this terraform command goes back to ${clientName}'s own permission settings, with no OpenCadre approval \\(recorded in OpenCadre as a policy pass\\)\\.$`);
  const clientLabel = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" }[client];
  const expectHandedBack = (r: Run) => {
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    if (client === "cursor") {
      // Cursor's no opinion: `agent_message` only, no `permission` field.
      const said = JSON.parse(r.out);
      expect(Object.keys(said)).toEqual(["agent_message"]);
      expect(said.agent_message).toMatch(handedBack(clientLabel));
    } else {
      expect(r.out).toBe("");
    }
    expect(r.err).toMatch(new RegExp(handedBack(clientLabel).source.replace(/\$$/, ""), "m"));
  };

  it.concurrent(`a genuine pending timeout under onTimeout "allow" is no opinion and a policy pass, never an allow`, async () => {
    const hub = await stubHub((_n, _req, res) => pending(res));
    try {
      expectHandedBack(await runGate(client, hub.url, "allow"));
      expect(hub.executed).toEqual([]);
      expect(hub.policyPasses).toMatchObject([{ reason: "timeout", action: COMMAND, category: "terraform", approvalId: "ap1", delivery: "live", client }]);
    } finally {
      await hub.close();
    }
  });

  it.concurrent(`an expired approval follows onTimeout: deny, or no opinion`, async () => {
    const hub = await stubHub((_n, _req, res) => json(res, 200, { approval: { id: "ap1", status: "expired" } }));
    try {
      expectDeny(client, await runGate(client, hub.url, "deny"), new RegExp(`no approval received in ${WAIT_SECONDS}s \\(expired\\)`));
      expectHandedBack(await runGate(client, hub.url, "allow"));
      expect(hub.executed).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  // Fleet coordination slice B: the agent that asked took the request back. Before, "withdrawn" was an unknown status
  // and denied as a malformed response; it must deny with its real reason, and never reach onTimeout's hand-back.
  it.concurrent(`a withdrawn request denies with its reason, even with onTimeout "allow"`, async () => {
    const hub = await stubHub((_n, _req, res) => json(res, 200, { approval: { id: "ap1", status: "withdrawn", decision_note: "not needed" } }));
    try {
      for (const onTimeout of ["allow", "deny"] as const) {
        const r = await runGate(client, hub.url, onTimeout);
        expectDeny(client, r, /^OpenCadre approval gate: withdrawn by the agent that asked: not needed\. Do not retry this or a workaround without asking the user\.$/);
        expect(r.out).not.toMatch(/malformed|no approval received|no decision in/);
      }
      expect(hub.policyPasses).toEqual([]);
      expect(hub.executed).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it.concurrent("an approval by a person allows, as before", async () => {
    const hub = await stubHub((_n, _req, res) => json(res, 200, { approval: { id: "ap1", status: "approved", decided_by_person_id: "p1", decided_by_person_name: "Pat", decision_note: "ok" } }));
    try {
      for (const onTimeout of ["allow", "deny"] as const) {
        const r = await runGate(client, hub.url, onTimeout);
        expect(r.code, `stderr: ${r.err}`).toBe(0);
        const reason = "Approved in OpenCadre by Pat: ok";
        expect(JSON.parse(r.out)).toEqual(client === "cursor"
          ? { permission: "allow", user_message: reason, agent_message: reason }
          : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } });
      }
    } finally {
      await hub.close();
    }
  });

  it.concurrent("a denial denies, as before", async () => {
    const hub = await stubHub((_n, _req, res) => json(res, 200, { approval: { id: "ap1", status: "denied", decided_by_person_id: "p1", decided_by_person_name: "Pat", decision_note: "no" } }));
    try {
      for (const onTimeout of ["allow", "deny"] as const) {
        expectDeny(client, await runGate(client, hub.url, onTimeout), /^OpenCadre approval gate: denied by Pat: no\. Do not retry/);
      }
    } finally {
      await hub.close();
    }
  });
});

// Which outcome counts is the LAST one before the deadline (claude-code's dialect; the rule is dialect-free).
describe("approval gate /wait: the last outcome before the deadline decides", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it.concurrent("an error followed by 'still pending' until the deadline is a timeout, which onTimeout governs", async () => {
    const hub = await stubHub((n, _req, res) => (n === 1 ? json(res, 503, {}) : pending(res)));
    try {
      const r = await runGate("claude-code", hub.url, "allow");
      // F7 / Q1f (flipped): onTimeout "allow" is no opinion now, never an explicit allow.
      expect(r.out).toBe("");
      expect(hub.policyPasses).toMatchObject([{ reason: "timeout" }]);
      expect(hub.waits()).toBeGreaterThan(1);
    } finally {
      await hub.close();
    }
  });

  it.concurrent("'still pending' followed by errors until the deadline is an error, even with onTimeout \"allow\"", async () => {
    const hub = await stubHub((n, _req, res) => (n === 1 ? pending(res) : json(res, 502, {})));
    try {
      const r = await runGate("claude-code", hub.url, "allow");
      expectErrorDeny("claude-code", r, new RegExp(`HTTP 502, still failing when the ${WAIT_SECONDS}s wait ran out`));
    } finally {
      await hub.close();
    }
  });
});
