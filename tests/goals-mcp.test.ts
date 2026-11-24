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
  const client = new Client({ name: "goals-mcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

describe("goal over MCP", () => {
  it("exposes set_goal/get_goal, and any agent's goal is visible to every other agent in the org", async () => {
    const { orgId } = createOrganization("MCP Goal Org");
    const supervisor = await connect(registerAgent(orgId, "Claude-Supervisor").apiKey);
    const worker = await connect(registerAgent(orgId, "agent1").apiKey);

    const names = (await supervisor.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["set_goal", "get_goal"]));

    expect(text(await worker.callTool({ name: "get_goal", arguments: {} }))).toBe("No goal set yet.");

    const set = text(await supervisor.callTool({ name: "set_goal", arguments: { text: "Ship the EGFR benchmark fix" } }));
    expect(set).toMatch(/^Goal set: "Ship the EGFR benchmark fix"/);
    expect(set).toContain("Claude-Supervisor");

    expect(text(await worker.callTool({ name: "get_goal", arguments: {} }))).toContain("Ship the EGFR benchmark fix");

    await supervisor.close();
    await worker.close();
  });

  it("rejects an empty goal", async () => {
    const { orgId } = createOrganization("MCP Goal Empty Org");
    const a = await connect(registerAgent(orgId, "Claude A").apiKey);
    expect(text(await a.callTool({ name: "set_goal", arguments: { text: "   " } }))).toMatch(/^Error:/);
    await a.close();
  });
});
