import { describe, expect, it, vi } from "vitest";
import { FLEET_SUITES, checkBroadcast, checkHealthEndpoint, runFleetHealth } from "../scripts/fleet-health-smoke.mjs";
import { runSmokeTest } from "../scripts/mcp-smoke-test.mjs";

describe("fleet-health-smoke", () => {
  it("documents all client suites", () => {
    expect(FLEET_SUITES.map((s) => s.id)).toEqual([
      "hub", "broadcast", "codex", "gemini-cli", "grok", "kimi", "qwen",
    ]);
  });

  it("checkHealthEndpoint accepts ok status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
    }));
    const result = await checkHealthEndpoint("https://hub.example", fetchImpl as unknown as typeof fetch);
    expect(result.pass).toBe(true);
  });

  it("checkBroadcast validates tool surface and call shape", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list") {
        return {
          ok: true,
          status: 200,
          text: async () => 'data: {"result":{"tools":[{"name":"broadcast_message"}]}}\n',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => 'data: {"result":{"content":[{"text":"Broadcast sent to 2 agent(s).\\nAgent B: queued, thread abc"}]}}\n',
      };
    });
    const result = await checkBroadcast({
      mcpUrl: "https://hub.example/mcp",
      apiKey: "agt_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.pass).toBe(true);
    expect(result.steps).toHaveLength(2);
  });

  it("runFleetHealth aggregates suite results", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "tools/list") {
        return {
          ok: true,
          status: 200,
          text: async () => 'data: {"result":{"tools":[{"name":"get_active_agents"},{"name":"get_messages"},{"name":"wait_for_message"},{"name":"reply"},{"name":"send_message"},{"name":"broadcast_message"}]}}\n',
        };
      }
      if (body.method === "tools/call" && body.params?.name === "get_active_agents") {
        return { ok: true, status: 200, text: async () => 'data: {"result":{"content":[{"text":"Test-Agent — online"}]}}\n' };
      }
      if (body.method === "tools/call" && body.params?.name === "get_messages") {
        return { ok: true, status: 200, text: async () => 'data: {"result":{"content":[{"text":"No new messages."}]}}\n' };
      }
      if (body.method === "tools/call" && body.params?.name === "wait_for_message") {
        return { ok: true, status: 200, text: async () => 'data: {"result":{"content":[{"text":"No new messages (timed out waiting)."}]}}\n' };
      }
      if (body.method === "tools/call" && body.params?.name === "broadcast_message") {
        return { ok: true, status: 200, text: async () => 'data: {"result":{"content":[{"text":"Broadcast sent to 0 agent(s)."}]}}\n' };
      }
      if (String(url).includes("/v1/messages")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    });

    const report = await runFleetHealth({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clients: ["codex"],
    });

    expect(report.suites.length).toBeGreaterThanOrEqual(3);
    expect(report.suites.some((s) => s.id === "hub")).toBe(true);
    expect(report.suites.some((s) => s.id === "broadcast")).toBe(true);
    expect(report.suites.some((s) => s.id === "codex")).toBe(true);
  });

  it("runSmokeTest is importable from mcp-smoke-test", async () => {
    const result = await runSmokeTest({ mcpUrl: "", apiKey: "" });
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.name).toBe("config");
  });
});
