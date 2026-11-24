import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { billingVerb, LAPSE_EXEMPT_WRITES, READ_ONLY_CODE, READ_TOOLS, readOnlyRefusal, workspaceBilling } from "../src/billing.js";
import { listApprovals, requestApproval } from "../src/approvals.js";

/**
 * READ/WRITE CLASSIFICATION COMPLETENESS.
 *
 * A lapsed workspace is READ-ONLY: reads keep working, writes are refused with 402. That promise holds
 * only if every surface that can be called has been CLASSIFIED -- MCP tools against `READ_TOOLS`, REST
 * verbs against `SAFE_METHODS` -- and the failure mode of getting it wrong is silent and asymmetric:
 *
 *   - A read tool left OFF the list is refused on a lapsed workspace, so a paying-then-lapsed customer
 *     cannot even read their own mail. Annoying, visible, and cheap.
 *   - A WRITE tool put ON the list is ALLOWED on a lapsed workspace: the one thing read-only exists to
 *     prevent, and it fails OPEN. That direction is the reason this file exists.
 *
 * What was already covered, and what this adds. `tests/billing.test.ts` checks ONE direction: every name
 * in `READ_TOOLS` is a real registered tool (so a typo does not silently cost a read). Nothing checked
 * the CONVERSE -- that every registered tool is on one side of the line and behaves as classified -- and
 * nothing drove a REST verb through the same predicate. `tests/rest-mcp-parity.test.ts` keeps a HAND
 * WRITTEN inventory of 30 tools and asserts it has length 30; a 58th tool added to `src/mcp.ts` without
 * touching that list passes every test in the repo.
 *
 * This file closes that. It enumerates the REGISTERED sets from the live objects (Express's own router
 * stack; the live MCP `tools/list`), never from a hand-copied list, so its coverage grows the moment a
 * tool or route is added. It then drives EVERY name through the real predicate with an INJECTED CLOCK
 * and requires the verdict to match the classification. A new, unclassified tool fails here on the push
 * that adds it -- the point of the whole exercise.
 *
 * It is deliberately a completeness GUARD, not a re-test of the billing rules: the boundary arithmetic
 * (trial end, grace) is `tests/billing.test.ts`'s subject. Here the workspace is pinned UNAMBIGUOUSLY
 * lapsed so the only variable is the classification of each name.
 */

// A clock far past any trial end, injected rather than waited for: the predicate takes `nowMs`, so we
// do not move the row's date and hope. This exercises the real decision path at a chosen instant.
const LAPSED_AT_MS = Date.parse("2099-01-01T00:00:00.000Z");

let restServer: ReturnType<typeof app.listen>;
let mcpServer: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  // Mirrors src/index.ts: MCP never passes through the Express app, so its enforcement is the per-tool
  // guard, not a middleware -- which is exactly why the tool vocabulary needs its own completeness check.
  mcpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req as never, res);
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, resolve));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => restServer.close(() => resolve()));
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
});

/** A workspace pinned read-only, with one plain agent key to enumerate tools under. */
function lapsedWorkspace(name: string) {
  const { orgId } = createOrganization(name);
  const agent = registerAgent(orgId, "Classifier");
  // Pin the row so there is no clock dependence at all: the trial ended long before LAPSED_AT_MS and
  // the subscription is a non-entitled status. Every call below reads this same read-only state.
  db.prepare(
    `UPDATE organizations SET trial_ends_at = ?, subscription_status = 'canceled' WHERE id = ?`,
  ).run("2000-01-01T00:00:00.000Z", orgId);
  // Sanity: the subject of this test really is read-only, under the same predicate the guard uses.
  expect(workspaceBilling(orgId, LAPSED_AT_MS).readOnly, "the fixture must actually be read-only").toBe(true);
  return { orgId, agentNoTrial: agent };
}

/** The verdict the guard itself would reach for `verb` on this workspace, with the clock injected. */
const verdict = (orgId: string, verb: string, role?: string) =>
  readOnlyRefusal(orgId, verb, role ? { role: role as never } : {}, LAPSED_AT_MS);

/** Every MCP tool the hub registers, straight from the live server -- not a copied list. */
async function registeredMcpTools(key: string): Promise<string[]> {
  const client = new Client({ name: "classification", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names.sort();
}

/** Every (METHOD, path) the Express app actually registers, read off its own router stack. */
function registeredRestRoutes(): string[] {
  const anyApp = app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (anyApp.router?.stack ?? anyApp._router?.stack ?? []) as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>;
  const out = new Set<string>();
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) out.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return [...out].sort();
}

/**
 * The tools that ARE writes, named. This list is the ONE place a human asserts an intent the code
 * cannot: `readOnlyRefusal` decides by set membership, so it cannot tell a write from a read -- only
 * WE can, and only by reading what each tool does. Keeping the write names here, and asserting the
 * registered set equals reads-plus-writes, is what makes "no write sits in READ_TOOLS" checkable
 * rather than assumed. A new tool is added to exactly one of these lists (or to neither, which fails).
 */
const WRITE_TOOLS = [
  "accept_task", "archive_memory", "ask_clarification", "broadcast_message", "claim_resource",
  "claim_task", "complete_task", "create_task", "decide_approval", "delete_fact", "record_decision",
  "register_webhook", "reject_task", "release_resource", "release_task", "remember", "renew_claim",
  "renew_resource_lock", "reply", "request_approval", "revoke_approval_grant", "save_task", "send_message",
  "set_capabilities", "set_fact", "set_goal", "set_round_budget", "set_status", "share_file",
  "supersede_memory", "supersede_task", "withdraw_approval", "set_wip_cap", "set_task_lane",
];

describe("the read/write partition is TOTAL and CORRECT on a lapsed workspace", () => {
  it("every registered MCP tool is classified -- read, or write; nothing unaccounted for", async () => {
    const w = lapsedWorkspace("Classification Totality");
    const registered = await registeredMcpTools(w.agentNoTrial.apiKey);

    // The instrument must actually see the tool set, or "every tool is classified" would be true of an
    // empty set. This is a floor, not the assertion -- the assertion is the set difference below.
    expect(registered.length, "tools/list returned implausibly few tools -- is the instrument attached?").toBeGreaterThan(50);

    const classified = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
    // THE FAILING ASSERTION FOR THE NEXT UNCLASSIFIED TOOL. Add a tool to src/mcp.ts and forget to
    // classify it: this reports its name. The fix is one word in `READ_TOOLS` (src/billing.ts) or one
    // line in `WRITE_TOOLS` above -- never silence.
    const unclassified = registered.filter((name) => !classified.has(name));
    expect(unclassified, `these registered tools are classified nowhere; add each to READ_TOOLS or WRITE_TOOLS: ${unclassified.join(", ")}`).toEqual([]);

    // And the reverse: a name that is classified but no longer registered is dead weight that would let
    // a reader believe a surface exists when it does not. Both directions, or the lists rot silently.
    const registeredSet = new Set(registered);
    const stale = [...classified].filter((name) => !registeredSet.has(name)).sort();
    expect(stale, `these names are classified but not registered as tools; remove them: ${stale.join(", ")}`).toEqual([]);
  });

  it("no WRITE tool sits in READ_TOOLS -- the direction that fails OPEN", () => {
    // If a write ever appears here it is ALLOWED on a lapsed workspace: the exact thing read-only
    // prevents. This one assertion is the whole reason the file was requested.
    const misclassified = WRITE_TOOLS.filter((name) => READ_TOOLS.has(name));
    expect(misclassified, `these are writes but READ_TOOLS lets them through on a lapsed workspace: ${misclassified.join(", ")}`).toEqual([]);
  });

  it("drives EVERY registered MCP tool through the real predicate: reads allowed, writes refused 402", async () => {
    const w = lapsedWorkspace("Classification Verdicts");
    const registered = await registeredMcpTools(w.agentNoTrial.apiKey);

    const wrong: string[] = [];
    for (const name of registered) {
      const refusal = verdict(w.orgId, name, "agent");
      const isRead = READ_TOOLS.has(name);
      // The verdict must agree with the classification, and the refusal must be the documented shape:
      // 402 and the machine-readable code, not merely "something truthy".
      if (isRead) {
        if (refusal !== null) wrong.push(`${name}: in READ_TOOLS but refused (${refusal.body.code})`);
      } else if (LAPSE_EXEMPT_WRITES.has(name)) {
        // A named write that only takes risk away (src/billing.ts LAPSE_EXEMPT_WRITES): allowed, and still a write.
        if (refusal !== null) wrong.push(`${name}: in LAPSE_EXEMPT_WRITES but refused (${refusal.body.code})`);
      } else {
        if (refusal === null) wrong.push(`${name}: a write but ALLOWED on a lapsed workspace`);
        else if (refusal.status !== 402 || refusal.body.code !== READ_ONLY_CODE) {
          wrong.push(`${name}: refused with ${refusal.status}/${refusal.body.code}, expected 402/${READ_ONLY_CODE}`);
        }
      }
    }
    expect(wrong, `the partition and the predicate disagree:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("exempts an operator from the refusal, so the person who must fix the bill can still act", async () => {
    const w = lapsedWorkspace("Classification Operator");
    const registered = await registeredMcpTools(w.agentNoTrial.apiKey);
    // The exemption is per-ACTOR, not per-tool: even a write clears for an operator. Asserted here so a
    // future "tighten it to writes too" change has to break a test that says why it must not.
    const write = registered.find((name) => !READ_TOOLS.has(name));
    expect(write, "need at least one write tool to prove the operator exemption").toBeTruthy();
    expect(verdict(w.orgId, write!, "operator"), "an operator is never refused").toBeNull();
    // Same instant, same tool, plain agent: refused. The exemption belongs to the actor.
    expect(verdict(w.orgId, write!, "agent")).not.toBeNull();
  });

  it("classifies REST verbs too: every registered route's verb is safe, or refused 402", () => {
    const w = lapsedWorkspace("Classification Routes");
    const routes = registeredRestRoutes();
    expect(routes.length, "no routes enumerated -- is the instrument attached to the real app?").toBeGreaterThan(50);

    const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
    const wrong: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(" ");
      // The verb exactly as src/rest.ts computes it for the guard.
      const refusal = verdict(w.orgId, billingVerb(method, path), "agent");
      if (SAFE.has(method)) {
        if (refusal !== null) wrong.push(`${route}: a safe verb but refused (${refusal.body.code})`);
      } else if (LAPSE_EXEMPT_WRITES.has(route)) {
        if (refusal !== null) wrong.push(`${route}: in LAPSE_EXEMPT_WRITES but refused (${refusal.body.code})`);
      } else if (refusal === null) {
        wrong.push(`${route}: ${method} is a write verb but ALLOWED on a lapsed workspace`);
      } else if (refusal.status !== 402 || refusal.body.code !== READ_ONLY_CODE) {
        wrong.push(`${route}: refused with ${refusal.status}/${refusal.body.code}, expected 402/${READ_ONLY_CODE}`);
      }
    }
    expect(wrong, `REST verbs and the predicate disagree:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("matches a healthy workspace's verdict for the same names -- the difference is the bill, not the name", () => {
    const healthy = createOrganization("Classification Healthy");
    const agent = registerAgent(healthy.orgId, "Classifier");
    const registered = registeredRestRoutes();
    // On a healthy workspace NOTHING is refused, read or write -- which proves the refusals above come
    // from the LAPSE and not from the predicate rejecting a name it does not recognise.
    //
    // The clock here is REAL time, not LAPSED_AT_MS: a freshly created workspace is still inside its
    // trial, and passing a 2099 instant would correctly lapse it and defeat the comparison. The only
    // variable between this case and the one above is the workspace's bill.
    const refused = registered
      .map((r) => r.split(" ")[0])
      .filter((method) => readOnlyRefusal(healthy.orgId, method, { role: "agent" as never }) !== null);
    expect(refused).toEqual([]);
    expect(agent.apiKey).toBeTruthy();
  });
});

/** The ONE deliberate exception to "a write is refused on a lapsed workspace" (src/billing.ts LAPSE_EXEMPT_WRITES):
 * withdrawing a pending approval request only cancels a risky action, so refusing it would leave the risk standing
 * until somebody pays. Pinned here so the list can't grow by accident, and driven end to end over both surfaces. */
describe("lapse-exempt writes: withdrawing is allowed, asking is not", () => {
  it("the list is exactly the withdraw tool and its REST twin, and both stay classified as WRITES", () => {
    expect([...LAPSE_EXEMPT_WRITES].sort()).toEqual(["POST /v1/approvals/:approvalId/withdraw", "withdraw_approval"]);
    expect(WRITE_TOOLS).toContain("withdraw_approval");
    expect(READ_TOOLS.has("withdraw_approval")).toBe(false);
    // Nothing else on the same path family slips through: the exemption is the exact route, not a prefix.
    expect(billingVerb("POST", "/v1/approvals/:approvalId/decide")).toBe("POST");
    expect(billingVerb("POST", "/v1/approvals")).toBe("POST");
    expect(billingVerb("POST", "/v1/approvals/:approvalId/withdraw")).toBe("POST /v1/approvals/:approvalId/withdraw");
  });

  it("over REST and MCP, a lapsed workspace's agent can withdraw its pending request but can't request a new one", async () => {
    const w = lapsedWorkspace("Classification Lapsed Withdraw");
    const agent = { id: w.agentNoTrial.agentId, name: "Classifier" };
    // Created in-process: the lapse refuses creating one over either surface, which is the second half of this test.
    const viaRest = await requestApproval(w.orgId, agent, { action: "terraform apply" });
    const viaMcp = await requestApproval(w.orgId, agent, { action: "terraform destroy" });
    const base = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${w.agentNoTrial.apiKey}`, "content-type": "application/json" };

    const withdrawn = await fetch(`${base}/v1/approvals/${viaRest.id}/withdraw`, { method: "POST", headers, body: "{}" });
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { approval: { status: string } }).approval.status).toBe("withdrawn");
    const asked = await fetch(`${base}/v1/approvals`, { method: "POST", headers, body: JSON.stringify({ action: "npm publish" }) });
    expect(asked.status).toBe(402);
    expect(((await asked.json()) as { code: string }).code).toBe(READ_ONLY_CODE);

    const client = new Client({ name: "classification", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: headers.authorization } } }));
    try {
      const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
      expect(text(await client.callTool({ name: "withdraw_approval", arguments: { approvalId: viaMcp.id } }))).toMatch(/^\[WITHDRAWN\] terraform destroy/);
      expect(text(await client.callTool({ name: "request_approval", arguments: { action: "npm publish", waitSeconds: 0 } }))).toMatch(new RegExp(`^${READ_ONLY_CODE}: `));
    } finally {
      await client.close();
    }
    expect(listApprovals(w.orgId, { status: "withdrawn" }).map((a) => a.id).sort()).toEqual([viaMcp.id, viaRest.id].sort());
    expect(listApprovals(w.orgId, {}).map((a) => a.action)).not.toContain("npm publish");
  });
});
