#!/usr/bin/env node
/**
 * Smoke-test OpenCadre MCP connectivity against a live tunnel or local server.
 * Validates tools/list, get_active_agents, and get_messages (peek).
 *
 * Usage:
 *   node scripts/mcp-smoke-test.mjs
 *   OPENCADRE_MCP_URL=... OPENCADRE_API_KEY=... node scripts/mcp-smoke-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = process.env.OPENCADRE_ENV_FILE ?? path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-watcher.env");

export function loadEnvFile(filePath = ENV_FILE) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function parseSseJson(text) {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(6));
  } catch {
    return null;
  }
}

export function extractToolNames(toolsListResult) {
  const tools = toolsListResult?.result?.tools ?? toolsListResult?.tools ?? [];
  return tools.map((t) => t.name ?? t).filter(Boolean);
}

export function extractToolCallText(data) {
  return data?.result?.content?.[0]?.text ?? "";
}

/** Derive REST base URL from MCP URL (https://host/mcp → https://host). */
export function deriveRestBaseUrl(mcpUrl) {
  return mcpUrl.replace(/\/mcp\/?$/, "");
}

export async function mcpRequest(mcpUrl, apiKey, method, params = {}, fetchImpl = fetch) {
  const res = await fetchImpl(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = parseSseJson(text);
  return { ok: res.ok, status: res.status, text, data };
}

/** @returns {{ pass: boolean, checks: Array<{ name: string, pass: boolean, detail: string }> }} */
export async function runSmokeTest({ mcpUrl, apiKey, restBaseUrl, fetchImpl = fetch } = {}) {
  const fileEnv = loadEnvFile();
  const url = mcpUrl ?? process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const key = apiKey ?? process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const restUrl = restBaseUrl ?? process.env.OPENCADRE_URL ?? fileEnv.OPENCADRE_URL ?? (url ? deriveRestBaseUrl(url) : "");

  const checks = [];

  if (!url || !key) {
    checks.push({ name: "config", pass: false, detail: "Missing OPENCADRE_MCP_URL or OPENCADRE_API_KEY" });
    return { pass: false, checks };
  }

  // tools/list
  try {
    const list = await mcpRequest(url, key, "tools/list", {}, fetchImpl);
    const names = extractToolNames(list.data ?? {});
    const required = ["get_active_agents", "get_messages", "wait_for_message", "reply", "send_message"];
    const missing = required.filter((n) => !names.includes(n));
    checks.push({
      name: "tools/list",
      pass: list.ok && missing.length === 0,
      detail: missing.length === 0
        ? `${names.length} tools (${required.join(", ")})`
        : `HTTP ${list.status}; missing: ${missing.join(", ") || "parse failed"}`,
    });
  } catch (err) {
    checks.push({ name: "tools/list", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // get_active_agents
  try {
    const agents = await mcpRequest(url, key, "tools/call", { name: "get_active_agents", arguments: {} }, fetchImpl);
    const text = extractToolCallText(agents.data ?? {});
    checks.push({
      name: "get_active_agents",
      pass: agents.ok && !text.startsWith("Error:"),
      detail: text.slice(0, 120) || `HTTP ${agents.status}`,
    });
  } catch (err) {
    checks.push({ name: "get_active_agents", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // get_messages (peek — do not consume mail)
  try {
    const msgs = await mcpRequest(url, key, "tools/call", { name: "get_messages", arguments: { peek: true } }, fetchImpl);
    const text = extractToolCallText(msgs.data ?? {});
    checks.push({
      name: "get_messages",
      pass: msgs.ok && !text.startsWith("Error:"),
      detail: text.includes("message") ? text.split("\n")[0].slice(0, 120) : text.slice(0, 80) || `HTTP ${msgs.status}`,
    });
  } catch (err) {
    checks.push({ name: "get_messages", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // REST GET /v1/messages?peek=true (Kimi/Qwen/Grok REST fallback path)
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
  }

  return { pass: checks.every((c) => c.pass), checks };
}

async function main() {
  const { pass, checks } = await runSmokeTest();
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  }
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
