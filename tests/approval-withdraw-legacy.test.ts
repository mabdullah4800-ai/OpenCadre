import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals, requestApproval, withdrawApproval, WITHDRAWN_DENY_NOTE } from "../src/approvals.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

// Security review 2 of #780. A gate hook from before #673 leaves its wait loop on any status but "pending", and on
// "withdrawn" it matches neither its approved nor its denied branch, so under a local onTimeout "allow" it falls
// through to the allow. An agent could withdraw its own request to get an instant allow and skip the person's veto.
// Such hooks are still installed on users' machines, so the hub never sends "withdrawn" to a client that didn't ask
// for it: over REST a withdrawn request reads as "denied", unless the request carries
//   X-OpenCadre-Approval-Statuses: withdrawn
// which the current gate (examples/hooks/opencadre-approval-gate.mjs) and the console send.
//
// THE OLD HOOKS ARE THE REAL ONES, pinned by commit, not reconstructions: each is extracted at test time with
// `git show <sha>:<path>`, together with every script it imports, into a private temp folder.
//   - pre-#673: b773f10d (b1a6b8a6^), the version that allowed.
//   - pre-#780: 1a9fbeeb (this PR's base), which already failed closed ("malformed response").
// Extracting rather than copying keeps ~260 KB of old code out of the tree; the sha pins it exactly as a copy would.

const PRE_673 = "b773f10d75b52b09373daf76ee15d23f800dfde7";
const PRE_780 = "1a9fbeebdf9ce28c8f7c7e402dc0416c069eb6e4";
const GATE = "examples/hooks/opencadre-approval-gate.mjs";

/** Writes `entry` at `sha` and, recursively, every relative module it imports, under a fresh folder. Returns the hook. */
function extractHook(sha: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `gate-${sha.slice(0, 8)}-`));
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = execFileSync("git", ["show", `${sha}:${file}`], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    mkdirSync(path.join(root, path.posix.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
    for (const [, spec] of source.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  };
  visit(GATE);
  return path.join(root, GATE);
}

let server: http.Server;
let baseUrl: string;
const hooks: Record<string, string> = {};
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hooks.pre673 = extractHook(PRE_673);
  hooks.pre780 = extractHook(PRE_780);
  hooks.current = path.join(process.cwd(), GATE);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "Coder");
  return { orgId, coder: { id: coder.agentId, name: "Coder", key: coder.apiKey } };
}

/** The gate, as Claude Code runs it, with local mode ask and onTimeout "allow" (the hub's policy is off, its default). */
function runGate(hook: string, key: string): Promise<{ code: number | null; out: string; err: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), "gate-withdrawn-"));
  const cfg = path.join(cwd, "gate.json");
  writeFileSync(cfg, JSON.stringify({ mode: "ask", onTimeout: "allow", onHubUnreachable: "deny", waitSeconds: 30 }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, "--client", "claude-code"], {
      env: {
        ...process.env, ...GATE_TEST_ENV,
        HOME: cwd, USERPROFILE: cwd, OPENCADRE_HOOK_HOME: cwd,
        CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "",
        OPENCADRE_URL: baseUrl, OPENCADRE_KEY: key,
        OPENCADRE_GATE_MODE: "", OPENCADRE_APPROVER: "", OPENCADRE_APPROVAL_WAIT: "",
        OPENCADRE_GATE_CONFIG: cfg, OPENCADRE_WAIT_RETRY_MS: "100",
      },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "w", tool_name: "Bash", tool_input: { command: "terraform apply" }, cwd }));
  });
}

/** Starts the gate, waits for its request, then the agent that asked withdraws it. */
async function withdrawnUnder(hook: string, name: string) {
  const { orgId, coder } = setup(name);
  const run = runGate(hook, coder.key);
  await waitFor(() => listApprovals(orgId, { status: "pending" }).length > 0, "the gate to create an approval request");
  const [pending] = listApprovals(orgId, { status: "pending" });
  expect(withdrawApproval(orgId, coder, pending.id, "nvm").ok).toBe(true);
  const r = await run;
  expect(r.code, `stderr: ${r.err}`).toBe(0);
  return JSON.parse(r.out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
}

describe("a withdrawn request never reaches a gate that doesn't know the status", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("the pre-#673 hook (the one that allowed) now DENIES: the hub tells it 'denied'", async () => {
    const said = await withdrawnUnder(hooks.pre673, "Legacy 673 Org");
    expect(said.permissionDecision).toBe("deny");
    expect(said.permissionDecisionReason).toContain("withdrawn by the agent that asked: nvm");
  });

  it("the pre-#780 hook still denies", async () => {
    expect((await withdrawnUnder(hooks.pre780, "Legacy 780 Org")).permissionDecision).toBe("deny");
  });

  it("the current hook opts in, sees 'withdrawn', and denies with the precise reason", async () => {
    expect(await withdrawnUnder(hooks.current, "Current Gate Org")).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "OpenCadre approval gate: withdrawn by the agent that asked: nvm. Do not retry this or a workaround without asking the user.",
    });
  });
});

describe("REST: withdrawn only for a client that opts in", () => {
  const get = (key: string, route: string, optIn: boolean) =>
    fetch(`${baseUrl}${route}`, { headers: { authorization: `Bearer ${key}`, ...(optIn ? { "x-opencadre-approval-statuses": "withdrawn" } : {}) } })
      .then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));

  it("reads, waits and lists show 'denied' with the reason in the note; the opt-in header shows 'withdrawn'", async () => {
    const { orgId, coder } = setup("REST Legacy Org");
    const req = await requestApproval(orgId, coder, { action: "npm publish" });
    expect(withdrawApproval(orgId, coder, req.id, "wrong branch").ok).toBe(true);

    for (const route of [`/v1/approvals/${req.id}`, `/v1/approvals/${req.id}/wait?timeoutSeconds=1`]) {
      const legacy = (await get(coder.key, route, false)).body.approval as Record<string, unknown>;
      expect(legacy, route).toMatchObject({ id: req.id, status: "denied", decision_note: `${WITHDRAWN_DENY_NOTE}: wrong branch`, decided_by_person_id: null });
      expect((await get(coder.key, route, true)).body.approval, route).toMatchObject({ id: req.id, status: "withdrawn", decision_note: "wrong branch" });
    }
    const legacyList = (await get(coder.key, "/v1/approvals", false)).body.approvals as Array<{ id: string; status: string }>;
    expect(legacyList.find((a) => a.id === req.id)?.status).toBe("denied");
    const list = (await get(coder.key, "/v1/approvals", true)).body.approvals as Array<{ id: string; status: string }>;
    expect(list.find((a) => a.id === req.id)?.status).toBe("withdrawn");
    // Asking for status=withdrawn by name is asking for the status.
    const named = (await get(coder.key, "/v1/approvals?status=withdrawn", false)).body.approvals as Array<{ id: string; status: string }>;
    expect(named.map((a) => [a.id, a.status])).toEqual([[req.id, "withdrawn"]]);
  });

  it("a withdrawal with no note still says why", async () => {
    const { orgId, coder } = setup("REST Legacy No Note Org");
    const req = await requestApproval(orgId, coder, { action: "rm -rf build" });
    withdrawApproval(orgId, coder, req.id);
    expect(((await get(coder.key, `/v1/approvals/${req.id}`, false)).body.approval as Record<string, unknown>).decision_note).toBe(WITHDRAWN_DENY_NOTE);
  });
});
