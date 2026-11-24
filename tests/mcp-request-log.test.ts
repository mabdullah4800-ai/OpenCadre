import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/mcp.js";
import { withRequestLog } from "../src/http-log.js";
import { setLogSink } from "../src/log.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Found in the timed connect runs: MCP request log lines had no agent id, so a client's first MCP call couldn't be
// attributed or timed. REST lines already carried it; MCP lines must too, and never the key.
let server: http.Server;
let base: string;
let lines: Array<Record<string, unknown>> = [];
let restore: () => void;

beforeAll(async () => {
  server = http.createServer(withRequestLog((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  }));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  restore?.();
  vi.unstubAllEnvs();
});

describe("MCP request log", () => {
  it("records the org and agent of an authenticated MCP call, and never the key", async () => {
    lines = [];
    restore = setLogSink((line) => lines.push(JSON.parse(line)));
    vi.stubEnv("OPENCADRE_LOG_LEVEL", "info");
    const { orgId } = createOrganization("MCP Log Org");
    const agent = registerAgent(orgId, "Logged-Agent");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const entry = lines.find((l) => l.msg === "request" && l.path === "/mcp");
    expect(entry).toMatchObject({ method: "POST", path: "/mcp", status: 200, orgId, agentId: agent.agentId });
    expect(JSON.stringify(lines)).not.toContain(agent.apiKey);
  });

  it("logs a rejected MCP call without any ids", async () => {
    lines = [];
    restore = setLogSink((line) => lines.push(JSON.parse(line)));
    vi.stubEnv("OPENCADRE_LOG_LEVEL", "info");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer agt_notarealkey", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const entry = lines.find((l) => l.msg === "request" && l.path === "/mcp")!;
    expect(entry.status).toBe(401);
    expect(entry.agentId).toBeUndefined();
  });
});
