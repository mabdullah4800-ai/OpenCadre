import { describe, expect, it } from "vitest";
import {
  parseClientArg,
  runClientVerification,
  verifyCodex,
  verifyGeminiCli,
  verifyGrok,
  verifyKimi,
  verifyLocalCliMcp,
  verifyQwen,
} from "../scripts/verify-client-live.mjs";
import { SESSION_SERVER } from "../cli/lib/device.mjs";

describe("verify-client-live", () => {
  it("checks the initialize name the proxy actually reports, not a duplicated literal", () => {
    // Regression: this checker compared serverInfo.name to the literal "opencadre" while the stdio proxy
    // reports "opencadre-session" (scripts/opencadre-mcp.mjs). A healthy hub therefore FAILED the client
    // check, and the test above did not catch it because its mock used the same wrong literal - the test
    // was consistent with the bug rather than with the system. Pin the value to its real source so the two
    // cannot drift apart again.
    expect(SESSION_SERVER).toBe("opencadre-session");
  });

  it("parseClientArg accepts codex, gemini-cli, grok, kimi, qwen, and all", () => {
    expect(parseClientArg(["codex"])).toEqual(["codex"]);
    expect(parseClientArg(["gemini-cli"])).toEqual(["gemini-cli"]);
    expect(parseClientArg(["grok"])).toEqual(["grok"]);
    expect(parseClientArg(["kimi"])).toEqual(["kimi"]);
    expect(parseClientArg(["qwen"])).toEqual(["qwen"]);
    expect(parseClientArg(["all"])).toEqual(["codex", "gemini-cli", "grok", "kimi", "qwen"]);
    expect(parseClientArg(["unknown"])).toBeNull();
  });

  it("verifyCodex passes with mocked MCP responses", async () => {
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (body.method === "initialize") {
        return new Response(
          `data: {"jsonrpc":"2.0","result":{"serverInfo":{"name":"${SESSION_SERVER}","version":"0.1.0"}}}\n`,
          { status: 200 },
        );
      }
      if (body.method === "tools/list") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"get_active_agents"},{"name":"get_messages"},{"name":"wait_for_message"},{"name":"reply"},{"name":"send_message"}]}}\n',
          { status: 200 },
        );
      }
      if (body.method === "tools/call" && body.params?.name === "get_active_agents") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Agent — online"}]}}\n',
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

    const result = await verifyCodex({
      mcpUrl: "https://example.com/mcp",
      apiKey: "agt_test",
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(result.pass).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "mcp/initialize",
      "mcp/tools/list",
      "mcp/get_active_agents",
      "mcp/get_messages",
    ]);
  });

  it("verifyGeminiCli passes with mocked MCP + REST responses", async () => {
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/messages/wait")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (url.includes("/v1/messages")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (body.method === "tools/list") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"wait_for_message"},{"name":"get_messages"}]}}\n',
          { status: 200 },
        );
      }
      if (body.method === "tools/call" && body.params?.name === "wait_for_message") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"No new messages (timed out waiting)."}]}}\n',
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    const result = await verifyGeminiCli({
      mcpUrl: "https://example.com/mcp",
      apiKey: "agt_test",
      restBaseUrl: "https://example.com",
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(result.pass).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "mcp/tools/list",
      "mcp/wait_for_message",
      "rest/messages",
      "rest/messages/wait",
    ]);
  });

  it("verifyLocalCliMcp passes with mocked MCP + REST responses", async () => {
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/messages/wait")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (url.includes("/v1/messages")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (body.method === "tools/list") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"wait_for_message"},{"name":"get_messages"}]}}\n',
          { status: 200 },
        );
      }
      if (body.method === "tools/call" && body.params?.name === "wait_for_message") {
        return new Response(
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"No new messages (timed out waiting)."}]}}\n',
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    for (const client of ["grok", "kimi", "qwen"] as const) {
      const result = await verifyLocalCliMcp({
        client,
        mcpUrl: "https://example.com/mcp",
        apiKey: "agt_test",
        restBaseUrl: "https://example.com",
        fetchImpl: mockFetch as typeof fetch,
      });
      expect(result.pass).toBe(true);
      expect(result.client).toBe(client);
    }
  });

  it("runClientVerification dispatches by client name", async () => {
    const mockFetch = async () => new Response("", { status: 404 });
    await expect(
      runClientVerification("codex", {
        mcpUrl: "https://example.com/mcp",
        apiKey: "agt_test",
        fetchImpl: mockFetch as typeof fetch,
      }),
    ).resolves.toHaveProperty("client", "codex");
    await expect(
      runClientVerification("grok", {
        mcpUrl: "https://example.com/mcp",
        apiKey: "agt_test",
        fetchImpl: mockFetch as typeof fetch,
      }),
    ).resolves.toHaveProperty("client", "grok");
  });

  it("verifyGrok, verifyKimi, verifyQwen delegate to verifyLocalCliMcp", async () => {
    const mockFetch = async (url: string) => {
      if (url.includes("/v1/")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response(
        'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"wait_for_message"}]}}\n',
        { status: 200 },
      );
    };
    const opts = {
      mcpUrl: "https://example.com/mcp",
      apiKey: "agt_test",
      restBaseUrl: "https://example.com",
      fetchImpl: mockFetch as typeof fetch,
    };
    await expect(verifyGrok(opts)).resolves.toHaveProperty("client", "grok");
    await expect(verifyKimi(opts)).resolves.toHaveProperty("client", "kimi");
    await expect(verifyQwen(opts)).resolves.toHaveProperty("client", "qwen");
  });
});
