import { describe, expect, it } from "vitest";
import {
  deriveRestBaseUrl,
  extractToolCallText,
  extractToolNames,
  parseSseJson,
  runSmokeTest,
} from "../scripts/mcp-smoke-test.mjs";

describe("mcp-smoke-test helpers", () => {
  it("parseSseJson extracts JSON from SSE data line", () => {
    const raw = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]}}\n\n";
    expect(parseSseJson(raw)).toEqual({ jsonrpc: "2.0", result: { tools: [] } });
  });

  it("extractToolNames reads MCP tools/list result", () => {
    const data = {
      result: {
        tools: [{ name: "get_messages" }, { name: "reply" }],
      },
    };
    expect(extractToolNames(data)).toEqual(["get_messages", "reply"]);
  });

  it("extractToolCallText reads tool call content", () => {
    const data = { result: { content: [{ type: "text", text: "No new messages." }] } };
    expect(extractToolCallText(data)).toBe("No new messages.");
  });

  it("deriveRestBaseUrl strips /mcp suffix", () => {
    expect(deriveRestBaseUrl("https://host.trycloudflare.com/mcp")).toBe("https://host.trycloudflare.com");
  });
});

describe("runSmokeTest", () => {
  it("fails fast when config is missing", async () => {
    const result = await runSmokeTest({ mcpUrl: "", apiKey: "", fetchImpl: fetch });
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.name).toBe("config");
  });

  it("passes when mocked MCP returns expected tools", async () => {
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/messages")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (body.method === "tools/list") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"get_active_agents"},{"name":"get_messages"},{"name":"wait_for_message"},{"name":"reply"},{"name":"send_message"}]}}\n',
          { status: 200 },
        );
      }
      if (body.method === "tools/call" && body.params?.name === "get_active_agents") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Cursor-Session (online)"}]}}\n',
          { status: 200 },
        );
      }
      if (body.method === "tools/call" && body.params?.name === "get_messages") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"No new messages."}]}}\n',
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    const result = await runSmokeTest({
      mcpUrl: "https://example.com/mcp",
      apiKey: "agt_test",
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(result.pass).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["tools/list", "get_active_agents", "get_messages", "rest/messages"]);
  });
});
