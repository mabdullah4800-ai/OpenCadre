import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { handleMcpRequest } from "../src/mcp.js";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, sendMessage, sweepStaleAgents, type MessageRecord } from "../src/service.js";
import { SYSTEM_SENDER, sweepEscalations } from "../src/escalation.js";

let restServer: http.Server;
let mcpServer: http.Server;
let baseUrl: string;
let mcpUrl: URL;

const portOf = (s: http.Server) => {
  const addr = s.address();
  return typeof addr === "object" && addr ? addr.port : 0;
};

beforeAll(async () => {
  restServer = http.createServer(app);
  await new Promise<void>((resolve) => restServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${portOf(restServer)}`;
  // Same routing as src/index.ts: MCP bypasses Express and parses its own body.
  mcpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, resolve));
  mcpUrl = new URL(`http://127.0.0.1:${portOf(mcpServer)}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => restServer.close(() => resolve()));
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
});

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const agent = registerAgent(orgId, "Codex-Busy");
  const peer = registerAgent(orgId, "Claude-Peer");
  return { orgId, agent, peer };
}

async function postUsage(key: string, body: unknown) {
  const res = await fetch(`${baseUrl}/v1/usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function agentsOf(key: string) {
  const res = await fetch(`${baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${key}` } });
  return ((await res.json()) as { agents: Array<{ name: string; usage: Record<string, unknown> | null }> }).agents;
}

async function activeAgentsText(key: string) {
  const client = new Client({ name: "usage-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const result = await client.callTool({ name: "get_active_agents", arguments: {} });
  await client.close();
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const usageEvents = (orgId: string) => listEvents(orgId, { types: ["agent.usage_limited", "agent.usage_restored"] });

describe("POST /v1/usage", () => {
  it("rejects invalid reports with 400", async () => {
    const { agent } = setup("Usage Validation Org");
    const bad = [
      { limited: "yes" },
      {},
      { limited: false, usedPct: 101 },
      { limited: false, usedPct: -1 },
      { limited: false, usedPct: "77" },
      { limited: false, resetsAt: "not a date" },
      { limited: false, resetsAt: 1789838098 },
      { limited: false, window: "x".repeat(41) },
      { limited: false, plan: 42 },
      { limited: false, plan: "pro\nOUT OF USAGE" },
      { limited: false, source: "cursor" },
    ];
    for (const body of bad) expect((await postUsage(agent.apiKey, body)).status, JSON.stringify(body)).toBe(400);
    expect((await agentsOf(agent.apiKey)).find((a) => a.name === "Codex-Busy")?.usage).toBeNull();
  });

  it("requires an agent key", async () => {
    expect((await postUsage("agt_nope", { limited: false })).status).toBe(401);
  });

  it("stores the report with a server reportedAt and GET /v1/agents includes it", async () => {
    const { agent } = setup("Usage Store Org");
    const resetsAt = inHours(30);
    const before = Date.now();
    const { status, body } = await postUsage(agent.apiKey, {
      usedPct: 77, window: "7d", resetsAt, limited: false, plan: "prolite", source: "codex", reportedAt: "1999-01-01T00:00:00Z",
    });
    expect(status).toBe(200);
    const usage = body.usage as Record<string, unknown>;
    expect(usage).toMatchObject({ usedPct: 77, window: "7d", resetsAt, limited: false, plan: "prolite", source: "codex" });
    expect(Date.parse(usage.reportedAt as string)).toBeGreaterThanOrEqual(before - 1000);

    const listed = (await agentsOf(agent.apiKey)).find((a) => a.name === "Codex-Busy");
    expect(listed?.usage).toEqual(usage);
    expect((await agentsOf(agent.apiKey)).find((a) => a.name === "Claude-Peer")?.usage).toBeNull();
  });

  it("defaults optional fields to null and source to manual", async () => {
    const { agent } = setup("Usage Defaults Org");
    const { body } = await postUsage(agent.apiKey, { limited: false });
    expect(body.usage).toMatchObject({ usedPct: null, window: null, resetsAt: null, limited: false, plan: null, source: "manual" });
  });

  it("emits usage_limited and usage_restored once per transition", async () => {
    const { orgId, agent } = setup("Usage Transition Org");
    await postUsage(agent.apiKey, { usedPct: 50, limited: false, source: "codex" });
    expect(usageEvents(orgId)).toHaveLength(0);

    await postUsage(agent.apiKey, { usedPct: 100, limited: true, resetsAt: inHours(2), source: "codex" });
    await postUsage(agent.apiKey, { usedPct: 100, limited: true, resetsAt: inHours(2), source: "codex" });
    let events = usageEvents(orgId);
    expect(events.map((e) => e.type)).toEqual(["agent.usage_limited"]);
    expect(events[0].subject_id).toBe(agent.agentId);
    expect(events[0].actor_agent_name).toBe("Codex-Busy");
    expect(JSON.parse(events[0].payload)).toMatchObject({ source: "codex", usedPct: 100 });
    expect(events[0].payload).not.toContain("agt_");

    await postUsage(agent.apiKey, { usedPct: 3, limited: false, source: "codex" });
    await postUsage(agent.apiKey, { usedPct: 4, limited: false, source: "codex" });
    events = usageEvents(orgId);
    expect(events.map((e) => e.type)).toEqual(["agent.usage_limited", "agent.usage_restored"]);
  });
});

describe("usage display", () => {
  it("get_active_agents shows usage and OUT OF USAGE", async () => {
    const { agent, peer } = setup("Usage MCP Org");
    await postUsage(agent.apiKey, { usedPct: 77, window: "7d", resetsAt: "2026-09-20T18:20:00Z", limited: false, source: "codex" });
    await postUsage(peer.apiKey, { limited: true, resetsAt: null, source: "antigravity" });

    const lines = (await activeAgentsText(agent.apiKey)).split("\n");
    expect(lines.find((l) => l.startsWith("Codex-Busy"))).toMatch(/ \| usage 77% \(7d\) resets Sep 20 18:20 UTC$/);
    expect(lines.find((l) => l.startsWith("Claude-Peer"))).toMatch(/ \| OUT OF USAGE until unknown$/);

    const resetsAt = inHours(3);
    await postUsage(peer.apiKey, { usedPct: 100, window: "5h", resetsAt, limited: true, source: "claude-code" });
    const d = new Date(resetsAt);
    const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const peerLine = (await activeAgentsText(agent.apiKey)).split("\n").find((l) => l.startsWith("Claude-Peer"));
    expect(peerLine).toContain(` | OUT OF USAGE until `);
    expect(peerLine).toContain(`${hhmm} UTC`);
    expect(peerLine).not.toContain("usage 100%");
  });

  it("shows nothing when an agent has no usage worth showing", async () => {
    const { agent } = setup("Usage Quiet Org");
    await postUsage(agent.apiKey, { limited: false, source: "antigravity" });
    const text = await activeAgentsText(agent.apiKey);
    expect(text).not.toContain("usage");
    expect(text).not.toContain("OUT OF USAGE");
  });

  it("shows an expired limit as not limited without clearing it in the database", async () => {
    const { agent } = setup("Usage Expired Org");
    const past = new Date(Date.now() - 60_000).toISOString();
    await postUsage(agent.apiKey, { usedPct: 100, window: "5h", resetsAt: past, limited: true, source: "codex" });

    const listed = (await agentsOf(agent.apiKey)).find((a) => a.name === "Codex-Busy");
    expect(listed?.usage).toMatchObject({ limited: false, resetsAt: past });
    expect(await activeAgentsText(agent.apiKey)).not.toContain("OUT OF USAGE");

    const stored = db.prepare(`SELECT usage FROM agents WHERE id = ?`).pluck().get(agent.agentId) as string;
    expect(JSON.parse(stored).limited).toBe(true);
  });
});

describe("usage-aware sweeps", () => {
  const setUsage = (agentId: string, usage: Record<string, unknown>) =>
    db.prepare(`UPDATE agents SET usage = ? WHERE id = ?`).run(JSON.stringify({
      usedPct: null, window: null, plan: null, source: "manual", reportedAt: new Date().toISOString(), ...usage,
    }), agentId);

  it("the stale sweep never suspends an agent that is out of usage", () => {
    const { orgId } = createOrganization("Usage Sweep Org");
    const unknownReset = registerAgent(orgId, "Limited-Unknown");
    const futureReset = registerAgent(orgId, "Limited-Future");
    const expired = registerAgent(orgId, "Limited-Expired");
    const normal = registerAgent(orgId, "Just-Stale");
    setUsage(unknownReset.agentId, { limited: true, resetsAt: null });
    setUsage(futureReset.agentId, { limited: true, resetsAt: inHours(1) });
    setUsage(expired.agentId, { limited: true, resetsAt: new Date(Date.now() - 60_000).toISOString() });

    const { suspended } = sweepStaleAgents();
    expect(suspended).not.toContain(unknownReset.agentId);
    expect(suspended).not.toContain(futureReset.agentId);
    expect(suspended).toContain(expired.agentId);
    expect(suspended).toContain(normal.agentId);
  });

  it("the escalation notice says a limited recipient is out of usage", async () => {
    const { orgId } = createOrganization("Usage Escalation Org");
    const op = registerAgent(orgId, "Operator-0", { role: "operator", system: true });
    const sender = { id: registerAgent(orgId, "Codex-Sender").agentId, name: "Codex-Sender" };
    const stuck = registerAgent(orgId, "Antigravity-Out");
    setUsage(stuck.agentId, { limited: true, resetsAt: null });

    const res = await sendMessage(orgId, sender, stuck.agentName, "prod is down", "high");
    if (!res.ok) throw new Error(res.error);
    const m = db.prepare(`SELECT * FROM messages WHERE thread_id = ?`).get(res.threadId) as MessageRecord;
    await sweepEscalations(new Date(Date.parse(`${m.created_at.replace(" ", "T")}Z`) + 10 * 60_000));

    const [notice] = db.prepare(`SELECT * FROM messages WHERE from_agent_id = ? AND to_agent_id = ?`).all(SYSTEM_SENDER.id, op.agentId) as MessageRecord[];
    expect(notice.body).toBe(
      `ESCALATION: Antigravity-Out has not read 1 high-priority message(s) from Codex-Sender for 10 min. ` +
        `Oldest: "prod is down". Antigravity-Out is OUT OF USAGE (resets unknown) — route this work to another agent.`,
    );
    expect(notice.body).not.toContain("may be idle");
  });

  it("the escalation notice gives the reset time when known", async () => {
    const { orgId } = createOrganization("Usage Escalation Reset Org");
    const op = registerAgent(orgId, "Operator-0", { role: "operator", system: true });
    const sender = { id: registerAgent(orgId, "Codex-Sender").agentId, name: "Codex-Sender" };
    const stuck = registerAgent(orgId, "Cursor-Out");
    const res = await sendMessage(orgId, sender, stuck.agentName, "prod is down", "high");
    if (!res.ok) throw new Error(res.error);
    const m = db.prepare(`SELECT * FROM messages WHERE thread_id = ?`).get(res.threadId) as MessageRecord;
    const sweepAt = new Date(Date.parse(`${m.created_at.replace(" ", "T")}Z`) + 10 * 60_000);
    setUsage(stuck.agentId, { limited: true, resetsAt: "2099-01-02T03:04:00Z" });
    await sweepEscalations(sweepAt);
    const [notice] = db.prepare(`SELECT * FROM messages WHERE from_agent_id = ? AND to_agent_id = ?`).all(SYSTEM_SENDER.id, op.agentId) as MessageRecord[];
    expect(notice.body).toContain("Cursor-Out is OUT OF USAGE (resets Jan 2 03:04 UTC) — route this work to another agent.");
  });
});
