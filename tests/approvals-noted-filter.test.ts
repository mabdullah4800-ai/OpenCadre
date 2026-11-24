import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/rest.js";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { decideApproval, requestApproval } from "../src/approvals.js";
import { signInPerson } from "./helpers/person.js";

// Board task cf34b4c2: list_approvals returned 355 [NOTED] notify-only records from opencadre-approval-gate (one per Bash
// command), burying the real pending approvals. The default view now leaves notify-only records (status "noted", what
// requestApproval writes for notifyOnly) out; includeNoted: true, or status: "noted", shows them. Nothing is deleted.
let restServer: http.Server;
let mcpServer: http.Server;
let restUrl: string;
let mcpUrl: URL;

beforeAll(async () => {
  restServer = http.createServer(app);
  await new Promise<void>((r) => restServer.listen(0, r));
  restUrl = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
  mcpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((r) => mcpServer.listen(0, r));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  await new Promise<void>((r) => restServer.close(() => r()));
  await new Promise<void>((r) => mcpServer.close(() => r()));
});

const NOTED_COUNT = 30;

/** One pending, one approved and one denied request, under 30 notify-only records written after them (newest first, so
 * on the old reader the notify-only records fill the first page). */
async function workspace(name: string) {
  const { orgId } = createOrganization(name);
  const coder = registerAgent(orgId, "Coder");
  const reader = registerAgent(orgId, "Reader");
  const self = { id: coder.agentId, name: "Coder" };
  const { decider } = await signInPerson(orgId, "Operator");
  const pending = await requestApproval(orgId, self, { action: "kubectl delete ns staging" });
  const approved = await requestApproval(orgId, self, { action: "npm publish" });
  const denied = await requestApproval(orgId, self, { action: "git push --force" });
  expect(decideApproval(orgId, decider, approved.id, "approve").ok).toBe(true);
  expect(decideApproval(orgId, decider, denied.id, "deny").ok).toBe(true);
  const noted: string[] = [];
  for (let i = 0; i < NOTED_COUNT; i++) {
    await new Promise((r) => setTimeout(r, 2)); // distinct created_at is not required (rowid breaks ties), just realistic
    noted.push((await requestApproval(orgId, self, { action: `rm -rf ./build-${i}`, notifyOnly: true })).id);
  }
  return { readerKey: reader.apiKey, real: [pending.id, approved.id, denied.id], noted };
}

async function rest(key: string, path: string) {
  const res = await fetch(`${restUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as { approvals: Array<{ id: string; status: string }>; notedHidden?: number } };
}

async function mcp(key: string, args: Record<string, unknown>) {
  const client = new Client({ name: "approvals-noted-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  try {
    const r = (await client.callTool({ name: "list_approvals", arguments: args })) as { content: Array<{ text: string }> };
    return r.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

describe("GET /v1/approvals hides notify-only records by default (cf34b4c2)", () => {
  it("the default shows pending and decided requests and no noted ones, and counts what it hid", async () => {
    const w = await workspace("Noted REST Default Org");
    const { status, body } = await rest(w.readerKey, "/v1/approvals");
    expect(status).toBe(200);
    expect(body.approvals.map((a) => a.id).sort()).toEqual([...w.real].sort());
    expect(body.approvals.map((a) => a.status).sort()).toEqual(["approved", "denied", "pending"]);
    expect(body.notedHidden).toBe(NOTED_COUNT);
  });

  it("includeNoted=true shows every record, the noted ones included", async () => {
    const w = await workspace("Noted REST Include Org");
    const { body } = await rest(w.readerKey, "/v1/approvals?includeNoted=true");
    expect(body.approvals).toHaveLength(w.real.length + NOTED_COUNT);
    expect(body.approvals.map((a) => a.id).sort()).toEqual([...w.real, ...w.noted].sort());
    expect(body.notedHidden).toBe(0);
  });

  it("status=noted still lists the noted records, and status=pending is unchanged", async () => {
    const w = await workspace("Noted REST Status Org");
    expect((await rest(w.readerKey, "/v1/approvals?status=noted")).body.approvals.map((a) => a.id).sort()).toEqual([...w.noted].sort());
    expect((await rest(w.readerKey, "/v1/approvals?status=pending")).body.approvals.map((a) => a.id)).toEqual([w.real[0]]);
  });
});

describe("list_approvals hides notify-only records by default (cf34b4c2)", () => {
  it("the default lists pending and decided requests, none noted, with the count it hid and how to see them", async () => {
    const w = await workspace("Noted MCP Default Org");
    const text = await mcp(w.readerKey, {});
    for (const id of w.real) expect(text).toContain(id);
    for (const id of w.noted) expect(text).not.toContain(id);
    expect(text).not.toMatch(/^\[NOTED\]/m);
    // All three fit on one page: no "showing N of M" line, which the old reader printed as 25 of 33.
    expect(text).not.toMatch(/showing \d+ of/);
    expect(text).toContain(`${NOTED_COUNT} notify-only [NOTED] records hidden`);
    expect(text).toContain("includeNoted: true");
  });

  it("includeNoted: true lists them, and the page count covers every record", async () => {
    const w = await workspace("Noted MCP Include Org");
    const text = await mcp(w.readerKey, { includeNoted: true, limit: 200 });
    for (const id of [...w.real, ...w.noted]) expect(text).toContain(id);
    expect(text.match(/^\[NOTED\]/gm)).toHaveLength(NOTED_COUNT);
    const paged = await mcp(w.readerKey, { includeNoted: true });
    expect(paged).toContain(`(showing 25 of ${w.real.length + NOTED_COUNT} approval requests`);
  });

  it("declares includeNoted in the tool's schema and description, so an agent can find it", async () => {
    const { orgId } = createOrganization("Noted MCP Schema Org");
    const client = new Client({ name: "approvals-noted-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${registerAgent(orgId, "R").apiKey}` } } }));
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "list_approvals")!;
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("includeNoted");
      expect(tool.description).toMatch(/includeNoted/);
    } finally {
      await client.close();
    }
  });
});
