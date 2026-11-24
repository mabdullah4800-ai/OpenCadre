import { describe, expect, it } from "vitest";
import path from "node:path";
import { createOrganization, registerAgent } from "../src/service.js";

describe("client onboarding prerequisites", () => {
  it("registers agents with API keys for MCP clients", () => {
    const { orgId } = createOrganization("Onboarding Test Org");
    const agent = registerAgent(orgId, "Test-Agent");
    expect(agent.apiKey).toMatch(/^agt_/);
    expect(agent.agentId).toBeTruthy();
  });
});

describe("CLIENT-ONBOARDING.md", () => {
  it("exists and documents key client types", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile("docs/CLIENT-ONBOARDING.md", "utf8");
    expect(doc).toContain("Claude Code");
    expect(doc).toContain("Cursor Cloud");
    expect(doc).toContain("wait_for_message");
    expect(doc).toContain("register_webhook");
    expect(doc).toContain("Client capability matrix");
    expect(doc).toContain("mcp-smoke-test.mjs");
    expect(doc).toContain("verify:codex");
    expect(doc).toContain("verify:gemini");
    expect(doc).toContain("Smoke test");
    expect(doc).toContain("claude-code-smoke.sh");
    expect(doc).toContain("broadcast_message");
    expect(doc).toContain("toAgents");
  });
});

describe("client example configs", () => {
  const examples = [
    "examples/clients/claude-code.mcp.json",
    "examples/clients/claude-code-smoke.sh",
    "examples/clients/codex.mcp.json",
    "examples/clients/codex-smoke.sh",
    "examples/clients/cursor-cloud.env",
    "examples/clients/cursor-cloud-smoke.sh",
    "examples/clients/cursor-local-smoke.sh",
    "examples/clients/gemini-cli.env",
    "examples/clients/gemini-cli.mcp.json",
    "examples/clients/gemini-cli-smoke.sh",
    "examples/clients/grok.env",
    "examples/clients/grok-smoke.sh",
    "examples/clients/kimi.env",
    "examples/clients/kimi-smoke.sh",
    "examples/clients/opencode.json",
    "examples/clients/qwen.env",
    "examples/clients/qwen-smoke.sh",
    "examples/clients/rest-poll-bridge.sh",
    "examples/clients/rest-smoke.sh",
    "examples/clients/lib/inbox-smoke.mjs",
    "examples/clients/antigravity/mcp_config.json",
    "examples/clients/antigravity/opencadre-inbox.md",
  ];

  it.each(examples)("includes %s", async (filePath) => {
    const { access } = await import("node:fs/promises");
    await expect(access(filePath)).resolves.toBeUndefined();
  });

  it("MCP JSON examples use Streamable HTTP shape", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["examples/clients/claude-code.mcp.json", "examples/clients/codex.mcp.json"]) {
      const json = JSON.parse(await readFile(file, "utf8"));
      expect(json.mcpServers.opencadre.url).toMatch(/\/mcp$/);
      expect(json.mcpServers.opencadre.headers.Authorization).toMatch(/^Bearer /);
    }
  });

  // OpenCode v2 nests MCP servers under `mcp.servers`, and a remote server names its transport with
  // `type: "remote"` (MEASURED against opencode v2.0.10 on 2026-09-19; the flat `mcp.<name>` shape is
  // not read - docs/design/HARNESS-OPENCODE-IDENTITY.md). Pin the shape so the example cannot drift
  // back to either the flat form or the `mcpServers` spelling the other clients use.
  it("OpenCode config example uses the mcp.servers/type remote shape", async () => {
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile("examples/clients/opencode.json", "utf8"));
    expect(json.mcp.servers.opencadre.type).toBe("remote");
    expect(json.mcp.servers.opencadre.url).toMatch(/\/mcp$/);
    expect(json.mcp.servers.opencadre.headers.Authorization).toMatch(/^Bearer /);
    expect(json.mcp.opencadre).toBeUndefined();
    expect(json.mcpServers).toBeUndefined();
  });
});

describe("Antigravity client", () => {
  it("mcp_config.json points at the hub MCP endpoint with a bearer key", async () => {
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile("examples/clients/antigravity/mcp_config.json", "utf8"));
    expect(json.mcpServers.opencadre.serverUrl).toMatch(/\/mcp$/);
    expect(json.mcpServers.opencadre.headers.Authorization).toMatch(/^Bearer /);
  });

  // Antigravity holds no connection between steps, so this rule is its inbox
  // loop. Every clause below closes a gap that left messages to it queued.
  it("inbox rule checks awareness at checkpoints and never idles silently", async () => {
    const { readFile } = await import("node:fs/promises");
    const rule = await readFile("examples/clients/antigravity/opencadre-inbox.md", "utf8");
    for (const tool of ["get_awareness", "ack_event", "wait_for_message", "set_status", "reply"]) {
      expect(rule).toContain(tool);
    }
    expect(rule).toMatch(/pure acknowledg/i);
    // Hooks only run inside a turn; the background wake watcher is what wakes an idle agent.
    expect(rule).toMatch(/opencadre-wake\.mjs.*BACKGROUND/s);
  });

  it("hooks.json wires the Stop and PreInvocation hooks to the inbox hook script", async () => {
    const { readFile, access } = await import("node:fs/promises");
    const hooksFile = "examples/clients/antigravity/hooks.json";
    const { "opencadre-inbox": hooks } = JSON.parse(await readFile(hooksFile, "utf8"));
    expect(hooks.enabled).toBe(true);
    expect(hooks.Stop[0].command).toMatch(/opencadre-antigravity\.mjs stop$/);
    expect(hooks.PreInvocation[0].command).toMatch(/opencadre-antigravity\.mjs pre-invocation$/);
    // Antigravity runs a hook command from the folder holding hooks.json, so that folder - not the
    // process cwd - is what the command's path is relative to. Resolving it any other way passes only
    // when the checkout happens to sit at one particular depth.
    const scriptPath = path.resolve(path.dirname(hooksFile), hooks.Stop[0].command.split(" ")[1]);
    await expect(access(scriptPath)).resolves.toBeUndefined();
  });

  it("is documented in CLIENT-ONBOARDING.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile("docs/CLIENT-ONBOARDING.md", "utf8");
    expect(doc).toContain("## Antigravity");
    expect(doc).toContain("examples/clients/antigravity/opencadre-inbox.md");
    // A non-peek background watcher marks mail read before the agent sees it.
    expect(doc).toMatch(/opencadre-watch\.mjs.*peek/s);
  });
});
