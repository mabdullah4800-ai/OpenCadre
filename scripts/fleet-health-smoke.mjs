#!/usr/bin/env node
/**
 * Fleet-health smoke — one entry point exercising every client integration path
 * against a live OpenCadre hub (production by default).
 *
 * Usage:
 *   node scripts/fleet-health-smoke.mjs
 *   node scripts/fleet-health-smoke.mjs --json
 *   OPENCADRE_MCP_URL=... OPENCADRE_API_KEY=... node scripts/fleet-health-smoke.mjs
 *
 * Exit 0 when all suites pass; 1 when any fail. Suitable for CI once secrets are wired.
 */
import { fileURLToPath } from "node:url";
import { deriveRestBaseUrl, loadEnvFile, mcpRequest, extractToolCallText, extractToolNames } from "./mcp-smoke-test.mjs";
import { runSmokeTest } from "./mcp-smoke-test.mjs";
import { runClientVerification, parseClientArg } from "./verify-client-live.mjs";

export const FLEET_SUITES = [
  { id: "hub", label: "Hub connectivity (MCP + REST peek)" },
  { id: "broadcast", label: "broadcast_message fan-out" },
  { id: "codex", label: "ChatGPT / Codex Developer Mode" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "grok", label: "Grok Build" },
  { id: "kimi", label: "Kimi CLI" },
  { id: "qwen", label: "Qwen-Agent" },
];

export async function checkHealthEndpoint(restUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${restUrl}/health`);
    const body = await res.json();
    return { pass: res.ok && body?.status === "ok", detail: res.ok ? "status=ok" : `HTTP ${res.status}` };
  } catch (err) {
    return { pass: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify broadcast_message is on the tool surface and accepts org channel (dry validation). */
export async function checkBroadcast({ mcpUrl, apiKey, fetchImpl = fetch } = {}) {
  const fileEnv = loadEnvFile();
  const url = mcpUrl ?? process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const key = apiKey ?? process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const steps = [];

  if (!url || !key) {
    return { pass: false, steps: [{ name: "config", pass: false, detail: "Missing OPENCADRE_MCP_URL or OPENCADRE_API_KEY" }] };
  }

  try {
    const list = await mcpRequest(url, key, "tools/list", {}, fetchImpl);
    const names = extractToolNames(list.data ?? {});
    steps.push({
      name: "tools/broadcast_message",
      pass: list.ok && names.includes("broadcast_message"),
      detail: names.includes("broadcast_message") ? "present on tool surface" : `missing (have ${names.length} tools)`,
    });
  } catch (err) {
    steps.push({ name: "tools/broadcast_message", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // Low-priority self ping via broadcast to empty-ish target — validates call shape without spamming fleet.
  // Uses channel=org which always resolves to at least zero other agents; server returns ok with deliveries array.
  try {
    const call = await mcpRequest(
      url,
      key,
      "tools/call",
      { name: "broadcast_message", arguments: { channel: "org", body: `[fleet-health] ping ${Date.now()}`, priority: "low" } },
      fetchImpl,
    );
    const text = extractToolCallText(call.data ?? {});
    steps.push({
      name: "call/broadcast_message",
      pass: call.ok && text.includes("Broadcast sent"),
      detail: text.slice(0, 120) || `HTTP ${call.status}`,
    });
  } catch (err) {
    steps.push({ name: "call/broadcast_message", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return { pass: steps.every((s) => s.pass), steps };
}

export async function runFleetHealth({ fetchImpl = fetch, clients = parseClientArg(["all"]) } = {}) {
  const fileEnv = loadEnvFile();
  const mcpUrl = process.env.OPENCADRE_MCP_URL ?? fileEnv.OPENCADRE_MCP_URL;
  const apiKey = process.env.OPENCADRE_API_KEY ?? fileEnv.OPENCADRE_API_KEY;
  const restUrl = process.env.OPENCADRE_URL ?? fileEnv.OPENCADRE_URL ?? (mcpUrl ? deriveRestBaseUrl(mcpUrl) : "");

  const suites = [];

  const hub = await runSmokeTest({ mcpUrl, apiKey, restBaseUrl: restUrl, fetchImpl });
  const health = restUrl ? await checkHealthEndpoint(restUrl, fetchImpl) : { pass: false, detail: "no REST URL" };
  suites.push({
    id: "hub",
    label: "Hub connectivity",
    pass: hub.pass && health.pass,
    checks: [...hub.checks, { name: "rest/health", pass: health.pass, detail: health.detail }],
  });

  const broadcast = await checkBroadcast({ mcpUrl, apiKey, fetchImpl });
  suites.push({ id: "broadcast", label: "broadcast_message", pass: broadcast.pass, checks: broadcast.steps });

  for (const client of clients ?? []) {
    const result = await runClientVerification(client, { mcpUrl, apiKey, restBaseUrl: restUrl, fetchImpl });
    suites.push({ id: client, label: result.client, pass: result.pass, checks: result.checks });
  }

  return { pass: suites.every((s) => s.pass), suites, mcpUrl: mcpUrl ?? null, restUrl: restUrl || null };
}

function printReport(report) {
  console.log(`OpenCadre fleet-health smoke`);
  if (report.mcpUrl) console.log(`  MCP:  ${report.mcpUrl}`);
  if (report.restUrl) console.log(`  REST: ${report.restUrl}`);
  console.log("");

  for (const suite of report.suites) {
    console.log(`=== ${suite.label} (${suite.id}) ===`);
    for (const c of suite.checks) {
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    }
    console.log(suite.pass ? "  SUITE: PASS\n" : "  SUITE: FAIL\n");
  }

  const passed = report.suites.filter((s) => s.pass).length;
  console.log(`SUMMARY: ${passed}/${report.suites.length} suites passed`);
  console.log(report.pass ? "FLEET HEALTH: PASS" : "FLEET HEALTH: FAIL");
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  const report = await runFleetHealth();
  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
