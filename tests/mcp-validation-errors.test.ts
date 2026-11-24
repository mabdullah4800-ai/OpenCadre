import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { handleMcpRequest, installPlainInputErrors } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Board task cf34b4c2: a tool call with a bad enum value or a missing required field came back as the schema library's
// raw issue text ('Invalid option: expected one of "acknowledged"|"acted"|"dismissed" at outcome', 'Invalid input:
// expected string, received undefined at threadId'). Every tool's validation error now says it plainly: the field, the
// valid values, or that it is required. The shape is unchanged: an isError result whose text keeps the SDK's prefix.
let server: http.Server;
let mcpUrl: URL;
let client: Client;

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
  await new Promise<void>((r) => server.listen(0, r));
  mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const { orgId } = createOrganization("Validation Errors Org");
  client = new Client({ name: "validation-errors-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${registerAgent(orgId, "V").apiKey}` } } }));
});
afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content.map((c) => c.text).join("\n") };
}

describe("MCP input validation errors name the valid values and the fields", () => {
  it("refuses oversized tool structures before schema validation, then serves a valid call", async () => {
    const r = await call("send_message", { toAgents: Array.from({ length: 10_001 }, () => ({})), body: "test" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("maximum of 10000 elements");
    const valid = await call("get_active_agents", {});
    expect(valid.isError, valid.text).not.toBe(true);
  });
  it("ack_event with a bad outcome names the three outcomes, plainly, in the same error shape", async () => {
    const r = await call("ack_event", { seq: 1, outcome: "done" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Input validation error: Invalid arguments for tool ack_event:");
    expect(r.text).toContain('outcome must be one of: acknowledged, acted, dismissed (got "done")');
  });

  it("reply with no arguments names both required fields", async () => {
    const r = await call("reply", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Input validation error: Invalid arguments for tool reply:");
    expect(r.text).toContain("threadId is required (a string)");
    expect(r.text).toContain("body is required (a string)");
  });

  it("reply missing only body names only body", async () => {
    const r = await call("reply", { threadId: "t-1" });
    expect(r.text).toContain("body is required (a string)");
    expect(r.text).not.toContain("threadId is required");
  });

  it("is generic: a wrong type and another tool's enum read the same way", async () => {
    expect((await call("ack_event", { seq: "seven", outcome: "acted" })).text).toContain('seq must be a number (got a string)');
    expect((await call("list_approvals", { status: "waiting" })).text)
      .toContain('status must be one of: pending, approved, denied, expired, noted, withdrawn (got "waiting")');
  });
});

// Review of #717 (Olive, at c225ab6c): the rejected value was JSON-stringified whole, so a 20,000-character string (or an
// object holding one) came back as a 20,000-character error, straight into the agent's context, where the SDK's own
// error was 174 characters. A rejected value may also hold something sensitive. So a string is previewed (bounded, with
// its length), any other value is named by its type only, every line is bounded, and so is the number of issues.
describe("validation errors are bounded and never echo a rejected value wholesale", () => {
  const MARK = "FIXTUREMARK";
  const big = `${MARK}${"x".repeat(20_000)}TAILMARK`;

  it("a huge string in an enum field is previewed, with its length, not reflected", async () => {
    const r = await call("list_approvals", { status: big });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("status must be one of: pending, approved, denied, expired, noted, withdrawn");
    expect(r.text).toContain(`(${big.length} characters)`);
    expect(r.text).not.toContain("TAILMARK");
    expect(r.text.length).toBeLessThan(600);
  });

  it("an object (or array) in an enum field is named by its type, and none of its contents appear", async () => {
    for (const value of [{ secretish: big }, [big, big]]) {
      const r = await call("list_approvals", { status: value });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/status must be one of: .* \(got an? (object|array)\)/);
      expect(r.text).not.toContain(MARK);
      expect(r.text).not.toContain("secretish");
      expect(r.text.length).toBeLessThan(600);
    }
  });

  it("a huge value of the wrong type is named by type only", async () => {
    const r = await call("ack_event", { seq: big, outcome: "acted" });
    expect(r.text).toContain("seq must be a number (got a string)");
    expect(r.text).not.toContain(MARK);
    expect(r.text.length).toBeLessThan(600);
  });

  it("if re-reading the input throws, the SDK's own InvalidParams error is rethrown unchanged (review of #717)", async () => {
    const original = new McpError(ErrorCode.InvalidParams, "Input validation error: Invalid arguments for tool t: raw");
    const fake = { validateToolInput: async () => { throw original; } };
    installPlainInputErrors(fake as unknown as Parameters<typeof installPlainInputErrors>[0]);
    const throwingSchema = { safeParseAsync: async () => { throw new Error("re-read exploded"); } };
    await expect(fake.validateToolInput({ inputSchema: throwingSchema }, {}, "t")).rejects.toBe(original);
    // ...and one that reports no issue keeps it too.
    const cleanSchema = { safeParseAsync: async () => ({ success: true }) };
    await expect(fake.validateToolInput({ inputSchema: cleanSchema }, {}, "t")).rejects.toBe(original);
  });

  it("many issues at once are capped, with a count of the rest", async () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) args[`${MARK}${i}`] = big;
    args.seq = big;
    args.outcome = { nested: big };
    const r = await call("ack_event", args);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("TAILMARK");
    expect(r.text.length).toBeLessThan(3_000);
  });
});
