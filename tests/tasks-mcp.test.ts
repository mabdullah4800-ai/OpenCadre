import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Same routing as src/index.ts: MCP bypasses Express and parses its own body.
let server: http.Server;
let mcpUrl: URL;

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
  mcpUrl = new URL(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function connect(apiKey: string) {
  const client = new Client({ name: "tasks-mcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

describe("timeline over MCP", () => {
  it("records phase and decisions, and get_timeline returns only what's after the cursor", async () => {
    const { orgId } = createOrganization("MCP Timeline Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);

    expect(text(await a.callTool({ name: "set_status", arguments: { task: "Design events", phase: "planning" } }))).toMatch(/^Status updated/);
    const decided = text(await a.callTool({ name: "record_decision", arguments: { title: "Events are append-only", scope: "src/events.ts" } }));
    const seq = Number(decided.match(/#(\d+)/)![1]);

    const all = text(await a.callTool({ name: "get_timeline", arguments: {} }));
    expect(all).toContain("agent.phase_changed");
    expect(all).toContain("decision.recorded");
    expect(text(await a.callTool({ name: "get_timeline", arguments: { after: seq } }))).toBe("No new events.");

    const rejected = await a.callTool({ name: "set_status", arguments: { task: "x", phase: "napping" } });
    expect(JSON.stringify(rejected)).toMatch(/isError|invalid/i);
    await a.close();
  });

  it("get_awareness summarizes what matters to you, then goes quiet", async () => {
    const { orgId } = createOrganization("MCP Awareness Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);
    const b = await connect(registerAgent(orgId, "Codex B").apiKey);

    await a.callTool({ name: "ask_clarification", arguments: { toAgent: "Codex B", body: "which branch?", timeoutSeconds: 0.1 } });
    const digest = text(await b.callTool({ name: "get_awareness", arguments: {} }));
    expect(digest).toMatch(/^You are Codex B\.\nOpenCadre awareness/);
    expect(digest).toContain("[P1]");
    expect(digest).toContain("Claude A asked you a question");

    const seq = Number(digest.match(/#(\d+) Claude A asked/)![1]);
    await b.callTool({ name: "ack_event", arguments: { seq, outcome: "acknowledged" } });
    expect(text(await b.callTool({ name: "get_awareness", arguments: {} }))).toBe("You are Codex B.\nNothing new that affects you.");
    await a.close();
    await b.close();
  });

  it("pull_events returns events addressed to you until you ack them", async () => {
    const { orgId } = createOrganization("MCP Deliveries Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);
    const b = await connect(registerAgent(orgId, "Codex B").apiKey);

    await a.callTool({ name: "send_message", arguments: { toAgent: "Codex B", body: "review PR 12?" } });
    const pulled = text(await b.callTool({ name: "pull_events", arguments: {} }));
    expect(pulled).toContain("message.sent");
    const seq = Number(pulled.match(/#(\d+)/)![1]);

    expect(text(await b.callTool({ name: "ack_event", arguments: { seq, outcome: "acted" } }))).toBe(`Event #${seq} acted.`);
    expect(text(await b.callTool({ name: "pull_events", arguments: {} }))).toBe("Nothing waiting for you.");
    expect(text(await a.callTool({ name: "ack_event", arguments: { seq, outcome: "acknowledged" } }))).toMatch(/^Error:/);
    await a.close();
    await b.close();
  });
});

describe("task board over MCP", () => {
  it("exposes the task tools and runs create → claim → conflict → complete", async () => {
    const { orgId } = createOrganization("MCP Tasks Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);
    const b = await connect(registerAgent(orgId, "Codex B").apiKey);

    const names = (await a.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "create_task", "list_tasks", "get_task", "claim_task", "renew_claim", "release_task", "complete_task", "accept_task", "reject_task",
      "set_capabilities", "get_capabilities",
    ]));

    const created = text(await a.callTool({ name: "create_task", arguments: { title: "Ship tasks API", description: "z".repeat(500) } }));
    const taskId = created.match(/id ([0-9a-f-]{36})/)![1];

    // get_task gives the full description without claiming; list_tasks clips it for the board view.
    const full = text(await b.callTool({ name: "get_task", arguments: { taskId } }));
    expect(full).toContain("z".repeat(500));
    expect(text(await b.callTool({ name: "get_task", arguments: { taskId: "not-a-real-id" } }))).toMatch(/^Error:/);

    expect(text(await a.callTool({ name: "claim_task", arguments: { taskId } }))).toMatch(/^Claimed:/);
    expect(text(await b.callTool({ name: "claim_task", arguments: { taskId } }))).toMatch(/claimed by Claude A/);
    expect(text(await b.callTool({ name: "list_tasks", arguments: { status: "claimed" } }))).toContain("Ship tasks API");
    expect(text(await a.callTool({ name: "complete_task", arguments: { taskId, summary: "PR opened" } }))).toMatch(/^Completed: \[done\]/);

    await a.close();
    await b.close();
  });

  it("accept_task/reject_task: self-review refused, a distinct agent's accept confirms, reject bounces back with a note", async () => {
    const { orgId } = createOrganization("MCP Review Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);
    const b = await connect(registerAgent(orgId, "Codex B").apiKey);

    const created = text(await a.callTool({ name: "create_task", arguments: { title: "Add rate limiting" } }));
    const taskId = created.match(/id ([0-9a-f-]{36})/)![1];
    await a.callTool({ name: "claim_task", arguments: { taskId } });
    await a.callTool({ name: "complete_task", arguments: { taskId, summary: "PR opened" } });

    // The claimant can't review their own completed task.
    expect(text(await a.callTool({ name: "accept_task", arguments: { taskId } }))).toMatch(/^Error:.*yourself/);
    expect(text(await a.callTool({ name: "reject_task", arguments: { taskId, note: "nope" } }))).toMatch(/^Error:.*yourself/);

    // A distinct agent rejects it with a note; the task goes back to claimed and the note is visible.
    const rejected = text(await b.callTool({ name: "reject_task", arguments: { taskId, note: "add integration tests" } }));
    expect(rejected).toMatch(/^Rejected: \[claimed\]/);
    expect(rejected).toContain("add integration tests");
    expect(text(await a.callTool({ name: "list_tasks", arguments: { status: "claimed" } }))).toContain("add integration tests");

    // Fixed and re-completed, a distinct agent now accepts it.
    await a.callTool({ name: "complete_task", arguments: { taskId, summary: "tests added" } });
    const accepted = text(await b.callTool({ name: "accept_task", arguments: { taskId } }));
    expect(accepted).toMatch(/^Accepted: \[done\]/);
    expect(accepted).toContain("accepted by Codex B");

    // Terminal: a second accept fails.
    expect(text(await a.callTool({ name: "accept_task", arguments: { taskId } }))).toMatch(/^Error:.*already been accepted/);

    await a.close();
    await b.close();
  });

  it("set_capabilities/get_capabilities and required_capabilities: a claim is refused until the agent declares what the task needs", async () => {
    const { orgId } = createOrganization("MCP Capabilities Org");
    const a = await connect(registerAgent(orgId, "agent1").apiKey);

    expect(text(await a.callTool({ name: "get_capabilities", arguments: {} }))).toBe("(none declared)");

    const created = text(await a.callTool({
      name: "create_task",
      arguments: { title: "AUDIT: deploy readiness", requiredCapabilities: ["shell", "git-write"] },
    }));
    expect(created).toContain("requires: shell, git-write");
    const taskId = created.match(/id ([0-9a-f-]{36})/)![1];

    const refused = text(await a.callTool({ name: "claim_task", arguments: { taskId } }));
    expect(refused).toMatch(/^Error:.*missing required capabilities.*shell.*git-write/);

    expect(text(await a.callTool({ name: "set_capabilities", arguments: { capabilities: ["shell", "git-write"] } })))
      .toBe("Capabilities set: shell, git-write");
    expect(text(await a.callTool({ name: "get_capabilities", arguments: {} }))).toBe("shell, git-write");

    expect(text(await a.callTool({ name: "claim_task", arguments: { taskId } }))).toMatch(/^Claimed:/);
    await a.close();
  });
});

describe("resource locks over MCP", () => {
  it("exposes the resource-lock tools and runs claim -> blocked -> release -> reclaim", async () => {
    const { orgId } = createOrganization("MCP Resource Locks Org");
    const a = await connect(registerAgent(orgId, "agent1").apiKey);
    const b = await connect(registerAgent(orgId, "agent2").apiKey);

    const names = (await a.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["claim_resource", "renew_resource_lock", "release_resource", "list_resource_locks"]));

    expect(text(await a.callTool({ name: "claim_resource", arguments: { resourceKey: "/Users/x/Projects/sample-project", note: "running the test suite" } })))
      .toMatch(/^Claimed: \/Users\/x\/Projects\/sample-project: held by agent1/);

    const blocked = text(await b.callTool({ name: "claim_resource", arguments: { resourceKey: "/Users/x/Projects/sample-project" } }));
    expect(blocked).toMatch(/^Error:.*locked by agent1/);

    expect(text(await a.callTool({ name: "renew_resource_lock", arguments: { resourceKey: "/Users/x/Projects/sample-project" } }))).toMatch(/^Renewed:/);
    expect(text(await b.callTool({ name: "list_resource_locks", arguments: {} }))).toContain("held by agent1");

    expect(text(await a.callTool({ name: "release_resource", arguments: { resourceKey: "/Users/x/Projects/sample-project" } })))
      .toBe("Released: /Users/x/Projects/sample-project");
    expect(text(await b.callTool({ name: "claim_resource", arguments: { resourceKey: "/Users/x/Projects/sample-project" } }))).toMatch(/^Claimed:/);

    await a.close();
    await b.close();
  });

  // Board task 081baee9: renew(60 s) on a lock held until 12:42 cut it to 12:13, and a holder's re-claim answered a bare
  // "Claimed" with no sign it was already theirs.
  it("says when a re-claim was already yours and whether the lease moved, and a short renew keeps the longer lease", async () => {
    const { orgId } = createOrganization("MCP Resource Lease Org");
    const a = await connect(registerAgent(orgId, "agent1").apiKey);
    const b = await connect(registerAgent(orgId, "agent2").apiKey);
    const until = (s: string) => s.match(/until (\S+)/)![1];

    const first = text(await a.callTool({ name: "claim_resource", arguments: { resourceKey: "repo", leaseSeconds: 3600 } }));
    expect(first).toMatch(/^Claimed: repo: held by agent1/);
    expect(first).not.toContain("alreadyHeld");

    const again = text(await a.callTool({ name: "claim_resource", arguments: { resourceKey: "repo", leaseSeconds: 60 } }));
    expect(again).toMatch(/^Already held by you \(alreadyHeld: true; lease unchanged/);
    expect(until(again)).toBe(until(first));

    const longer = text(await a.callTool({ name: "claim_resource", arguments: { resourceKey: "repo", leaseSeconds: 7200 } }));
    expect(longer).toMatch(/^Already held by you \(alreadyHeld: true; lease extended/);
    expect(Date.parse(until(longer))).toBeGreaterThan(Date.parse(until(first)));

    const shortRenew = text(await a.callTool({ name: "renew_resource_lock", arguments: { resourceKey: "repo", leaseSeconds: 60 } }));
    expect(shortRenew).toMatch(/^Lease kept, not shortened:/);
    expect(until(shortRenew)).toBe(until(longer));

    expect(text(await b.callTool({ name: "claim_resource", arguments: { resourceKey: "repo" } }))).toMatch(/^Error:.*locked by agent1/);

    const tools = (await a.listTools()).tools;
    const desc = (name: string) => tools.find((t) => t.name === name)!.description!;
    expect(desc("renew_resource_lock")).toMatch(/never shortens/);
    expect(desc("claim_resource")).toMatch(/alreadyHeld/);

    await a.close();
    await b.close();
  });
});
