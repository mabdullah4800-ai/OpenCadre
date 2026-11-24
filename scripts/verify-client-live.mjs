#!/usr/bin/env node
/**
 * Live verification for client-specific connect paths against a running OpenCadre instance.
 * Simulates the exact HTTP/MCP sequences each client would use.
 *
 * Usage:
 *   node scripts/verify-client-live.mjs codex
 *   node scripts/verify-client-live.mjs gemini-cli
 *   node scripts/verify-client-live.mjs grok
 *   node scripts/verify-client-live.mjs kimi
 *   node scripts/verify-client-live.mjs qwen
 *   node scripts/verify-client-live.mjs all
 */
import { fileURLToPath } from "node:url";
import {
  deriveRestBaseUrl,
  extractToolCallText,
  extractToolNames,
  loadEnvFile,
  mcpRequest,
} from "./mcp-smoke-test.mjs";
// The name the stdio proxy actually reports in initialize. Imported rather than repeated as a literal:
// this file used to hardcode "opencadre" while the proxy reports "opencadre-session", so the client check
// failed against a healthy hub and its own test passed anyway (the test mocked the same wrong string).
import { SESSION_SERVER } from "../cli/lib/device.mjs";

const LOCAL_CLI_CLIENTS = ["gemini-cli", "grok", "kimi", "qwen"];
const CLIENTS = ["codex", ...LOCAL_CLI_CLIENTS];

export function parseClientArg(argv = process.argv.slice(2)) {
  const arg = argv[0] ?? "all";
  if (arg === "all") return CLIENTS;
  if (CLIENTS.includes(arg)) return [arg];
  return null;
}

/** Codex / ChatGPT Developer Mode — Streamable HTTP MCP session bootstrap. */
export async function verifyCodex({ mcpUrl, apiKey, fetchImpl = fetch } = {}) {
  const fileEnv = loadEnvFile();
  const url = mcpUrl ?? process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const key = apiKey ?? process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const checks = [];

  if (!url || !key) {
    return { client: "codex", pass: false, checks: [{ name: "config", pass: false, detail: "Missing OPENCADRE_MCP_URL or OPENCADRE_API_KEY" }] };
  }

  // initialize — Codex sends this on MCP server connect
  try {
    const init = await mcpRequest(
      url,
      key,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-live-verify", version: "1.0" },
      },
      fetchImpl,
    );
    const serverInfo = init.data?.result?.serverInfo?.name ?? "";
    checks.push({
      name: "mcp/initialize",
      pass: init.ok && serverInfo === SESSION_SERVER,
      detail: init.ok ? `server=${serverInfo}` : `HTTP ${init.status}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/initialize", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // tools/list — Codex discovers tool surface
  try {
    const list = await mcpRequest(url, key, "tools/list", {}, fetchImpl);
    const names = extractToolNames(list.data ?? {});
    const required = ["get_active_agents", "get_messages", "wait_for_message", "reply", "send_message"];
    const missing = required.filter((n) => !names.includes(n));
    checks.push({
      name: "mcp/tools/list",
      pass: list.ok && missing.length === 0,
      detail: missing.length === 0 ? `${names.length} tools` : `missing: ${missing.join(", ")}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/tools/list", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // get_active_agents — turn-start inbox check pattern
  try {
    const agents = await mcpRequest(url, key, "tools/call", { name: "get_active_agents", arguments: {} }, fetchImpl);
    const text = extractToolCallText(agents.data ?? {});
    checks.push({
      name: "mcp/get_active_agents",
      pass: agents.ok && !text.startsWith("Error:"),
      detail: text.slice(0, 100) || `HTTP ${agents.status}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/get_active_agents", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // get_messages peek — per-turn inbox poll (cloud turn-based pattern)
  try {
    const msgs = await mcpRequest(url, key, "tools/call", { name: "get_messages", arguments: { peek: true } }, fetchImpl);
    const text = extractToolCallText(msgs.data ?? {});
    checks.push({
      name: "mcp/get_messages",
      pass: msgs.ok && !text.startsWith("Error:"),
      detail: text.slice(0, 80) || `HTTP ${msgs.status}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/get_messages", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return { client: "codex", pass: checks.every((c) => c.pass), checks };
}

/** Local CLI clients — MCP HTTP transport + REST long-poll fallback. */
export async function verifyLocalCliMcp({ client, mcpUrl, apiKey, restBaseUrl, fetchImpl = fetch } = {}) {
  const fileEnv = loadEnvFile();
  const url = mcpUrl ?? process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const key = apiKey ?? process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const restUrl = restBaseUrl ?? process.env.OPENCADRE_URL ?? fileEnv.OPENCADRE_URL ?? (url ? deriveRestBaseUrl(url) : "");
  const checks = [];

  if (!url || !key) {
    return {
      client,
      pass: false,
      checks: [{ name: "config", pass: false, detail: "Missing OPENCADRE_MCP_URL or OPENCADRE_API_KEY" }],
    };
  }

  try {
    const list = await mcpRequest(url, key, "tools/list", {}, fetchImpl);
    const names = extractToolNames(list.data ?? {});
    checks.push({
      name: "mcp/tools/list",
      pass: list.ok && names.includes("wait_for_message"),
      detail: list.ok ? `${names.length} tools, wait_for_message=${names.includes("wait_for_message")}` : `HTTP ${list.status}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/tools/list", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    const wait = await mcpRequest(
      url,
      key,
      "tools/call",
      { name: "wait_for_message", arguments: { timeoutSeconds: 2, peek: true } },
      fetchImpl,
    );
    const text = extractToolCallText(wait.data ?? {});
    checks.push({
      name: "mcp/wait_for_message",
      pass: wait.ok && !text.startsWith("Error:"),
      detail: text.slice(0, 80) || `HTTP ${wait.status}`,
    });
  } catch (err) {
    checks.push({ name: "mcp/wait_for_message", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  if (restUrl) {
    try {
      const res = await fetchImpl(`${restUrl}/v1/messages?peek=true`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.json();
      const count = Array.isArray(body?.messages) ? body.messages.length : -1;
      checks.push({
        name: "rest/messages",
        pass: res.ok && count >= 0,
        detail: res.ok ? `${count} message(s) (peek)` : `HTTP ${res.status}`,
      });
    } catch (err) {
      checks.push({ name: "rest/messages", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }

    try {
      const res = await fetchImpl(`${restUrl}/v1/messages/wait?timeoutSeconds=2&peek=true`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.json();
      const count = Array.isArray(body?.messages) ? body.messages.length : -1;
      checks.push({
        name: "rest/messages/wait",
        pass: res.ok && count >= 0,
        detail: res.ok ? `${count} message(s) after 2s wait (peek)` : `HTTP ${res.status}`,
      });
    } catch (err) {
      checks.push({ name: "rest/messages/wait", pass: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return { client, pass: checks.every((c) => c.pass), checks };
}

export async function verifyGeminiCli(opts = {}) {
  return verifyLocalCliMcp({ ...opts, client: "gemini-cli" });
}

export async function verifyGrok(opts = {}) {
  return verifyLocalCliMcp({ ...opts, client: "grok" });
}

export async function verifyKimi(opts = {}) {
  return verifyLocalCliMcp({ ...opts, client: "kimi" });
}

export async function verifyQwen(opts = {}) {
  return verifyLocalCliMcp({ ...opts, client: "qwen" });
}

export async function runClientVerification(client, opts = {}) {
  if (client === "codex") return verifyCodex(opts);
  if (client === "gemini-cli") return verifyGeminiCli(opts);
  if (client === "grok") return verifyGrok(opts);
  if (client === "kimi") return verifyKimi(opts);
  if (client === "qwen") return verifyQwen(opts);
  throw new Error(`Unknown client: ${client}`);
}

function printResult(result) {
  console.log(`\n=== ${result.client} live verification ===`);
  for (const c of result.checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  }
  console.log(result.pass ? "RESULT: PASS\n" : "RESULT: FAIL\n");
}

async function main() {
  const clients = parseClientArg();
  if (!clients) {
    console.error("Usage: node scripts/verify-client-live.mjs <codex|gemini-cli|grok|kimi|qwen|all>");
    process.exit(1);
  }

  let allPass = true;
  for (const client of clients) {
    const result = await runClientVerification(client);
    printResult(result);
    allPass = allPass && result.pass;
  }
  process.exit(allPass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
