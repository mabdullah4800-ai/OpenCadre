import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals } from "../src/approvals.js";
import { mcpRequest, extractToolCallText } from "../scripts/mcp-smoke-test.mjs";
import { runShellTool, splitApprovers } from "../scripts/deepseek-shell-guard.mjs";

/**
 * G7 (docs/ops/HUB-OPERATIONS.md §7): *where else* does config key on an agent name?
 *
 * §4 came from `.opencadre/approval-gate.json` naming two retired agents. The survey found a
 * second surface: `scripts/deepseek-agent-bridge.mjs` used to default `DEEPSEEK_SHELL_APPROVER` to
 * `"Claude-Supervisor,Claude-LeadImplementer"` -- the same two retired names -- and
 * `deepseek-shell-guard.mjs` passes the first name to `request_approval` as `approver`.
 *
 * That default is now gone. It was fixed in its own PR off `origin/main`, deliberately *not* in
 * parked #227's files: waiting for #227 is what left it live.
 *
 * The approval *gate* (#277) survives a dead approver: it retries without one and warns. The shell
 * guard deliberately does not. The second test below measures what it does instead -- the hub
 * refuses the request at creation, so nothing is left for anyone to decide. What the guard did gain
 * is a *diagnostic*: it now names `DEEPSEEK_SHELL_APPROVER` when the refusal was about an approver,
 * which is why that test asserts the hub's own message is still surfaced verbatim.
 */

/** The bridge runs its whole message loop at import time, so it can only be inspected as source. */
const BRIDGE_SRC = readFileSync(new URL("../scripts/deepseek-agent-bridge.mjs", import.meta.url), "utf8");
let server: http.Server;
let mcpUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  mcpUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function makeCallHubTool(apiKey: string) {
  return async (name: string, args: Record<string, unknown>) => {
    const res = await mcpRequest(mcpUrl, apiKey, "tools/call", { name, arguments: args });
    if (!res.ok) throw new Error(`MCP ${name} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    // As the bridge does (callHubToolStructured): the text AND the structured approval record run_shell checks.
    return { text: extractToolCallText(res.data ?? {}), structured: res.data?.result?.structuredContent ?? null };
  };
}

describe("the shell guard's approver config is keyed on an agent name", () => {
  it("carries no agent-name literal, so no workspace's naming can lock it out", () => {
    // Read the shipped default rather than restating it -- but assert the INVARIANT, not a literal.
    // The first version of this test pinned `?? "Claude-Supervisor,Claude-LeadImplementer"` verbatim,
    // which is a pin on the DEFECT: it fails the moment the defect is fixed, which is what happened.
    // This shape is green before and after the fix, and reddens only if a name comes back.
    const assignment = /const SHELL_APPROVER = [^;]*;/.exec(BRIDGE_SRC);
    expect(assignment).not.toBeNull();
    expect(assignment![0]).toContain("process.env.DEEPSEEK_SHELL_APPROVER");
    expect(assignment![0]).not.toMatch(/\?\?\s*["'][^"']+["']/);

    // And an empty value must reach the hub as NO approver (the operator route), not as an approver
    // named "" -- which would be a name resolving to nobody, i.e. the outage this file exists for.
    expect(splitApprovers("")).toEqual({ primary: undefined, extras: [] });
    // The guard still takes the first name verbatim when one IS configured, with no existence check.
    // That residual coupling is what the diagnostic below exists to make visible.
    expect(splitApprovers("Claude-Supervisor,Claude-LeadImplementer").primary).toBe("Claude-Supervisor");
  });

  it("MEASURED: a dead approver name stops the command AND leaves nothing an operator can decide", async () => {
    const { orgId } = createOrganization("Shell Guard Dead Approver Org");
    const coder = registerAgent(orgId, "agent1");
    const allowed = realpathSync(mkdtempSync(path.join(tmpdir(), "shell-dead-approver-")));

    const result = await runShellTool(
      makeCallHubTool(coder.apiKey),
      { cwd: allowed, command: "env X=1 echo should-not-be-reached" },
      { allowedPaths: [allowed], approver: "Claude-Supervisor", totalWaitMs: 2000 },
    );

    // Fail-closed: the command does not run. That half is correct.
    expect(String(result)).not.toContain("should-not-be-reached");
    expect(String(result)).toContain('No agent found matching approver "Claude-Supervisor"');

    // The half that is not: the request is refused at creation, so unlike the approval gate (#277,
    // which retries without the approver and lets an operator decide) there is no pending request
    // for anyone to act on. The lane is simply unable to run the command.
    expect(listApprovals(orgId, { status: "pending" })).toHaveLength(0);
  });

  it("announces the operator route at startup, because a silent default is indistinguishable", () => {
    // Nothing inside a run_shell request says whether an approver was configured or absent, so the
    // route it took is invisible from the call. The bridge states it once, only when shell is on.
    expect(BRIDGE_SRC).toContain("DEEPSEEK_SHELL_APPROVER is not set");
    expect(BRIDGE_SRC).toMatch(/SHELL_ALLOWED_PATHS\.length > 0 && !SHELL_APPROVER/);
    // Contrast with the gate's configured shape: no name at all, so nothing about it can go stale.
    expect(splitApprovers(undefined).primary).toBeUndefined();
  });
});
