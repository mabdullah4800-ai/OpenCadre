#!/usr/bin/env node
// Times a real connect, end to end, the way a new user experiences it (R5, five-minute connect).
//
//   OPENCADRE_OPERATOR_KEY=… node scripts/time-connect.mjs --client codex [--hub https://hub.opencadre.example] [--name Codex-Timing] [--out docs/planning/CONNECT_TIMING.md]
//
// It creates a connect code, prints the command to run, then watches the hub and stamps each stage:
//   command shown → CLI finished (installed) → client connected (online)
// When the agent is online it prints the times and appends one row to --out. The operator key is read from the
// environment and never printed; the connect code is shown because the command needs it (it works once, for 15 minutes).

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const CLIENTS = ["claude-code", "codex", "cursor", "antigravity", "gemini"];
const LIMIT_MS = 30 * 60_000;

const { values } = parseArgs({
  options: {
    client: { type: "string" },
    hub: { type: "string", default: "https://hub.opencadre.example" },
    name: { type: "string" },
    out: { type: "string", default: "docs/planning/CONNECT_TIMING.md" },
    "poll-ms": { type: "string", default: "2000" },
    note: { type: "string", default: "" },
  },
});

const fail = (message) => {
  console.error(`time-connect: ${message}`);
  process.exit(2);
};

const client = values.client;
if (!CLIENTS.includes(client ?? "")) fail(`--client must be one of ${CLIENTS.join(", ")}`);
const key = process.env.OPENCADRE_OPERATOR_KEY;
if (!key) fail("set OPENCADRE_OPERATOR_KEY to an operator key for the workspace to connect into (it's never printed)");
const hub = values.hub.replace(/\/+$/, "");
const pollMs = Math.max(250, Number(values["poll-ms"]) || 2000);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(4);
const agentName = values.name ?? `${client}-timing-${stamp}`;

async function api(method, path, body) {
  const res = await fetch(`${hub}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${method} ${path} answered ${res.status}: ${data.error ?? "no details"}`);
  return data;
}

const minutes = (ms) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const created = await api("POST", "/v1/connect-codes", { agentName, client });
const t0 = Date.now();
console.log(`\nConnecting "${agentName}" (${client}). Run this on the agent's machine, in its working folder:\n\n  ${created.command}\n`);
console.log("Timing from now. Ctrl+C to stop.\n");

const reached = {};
let last = "waiting";
while (Date.now() - t0 < LIMIT_MS) {
  const status = await api("GET", `/v1/connect-codes/${created.code}/status`);
  const stage = status.stage ?? (status.state === "redeemed" ? (status.agentOnline ? "online" : "installed") : status.state);
  if (stage !== last) {
    last = stage;
    if (!reached[stage]) reached[stage] = Date.now() - t0;
    const hint = {
      installed: "CLI finished. Now restart or open the client so it connects.",
      not_started: "Still not connected 10 minutes after install. Check the client is restarted.",
      online: "Client connected.",
      offline: "Client was connected, then went quiet.",
      expired: "The code expired before it was used.",
    }[stage] ?? "";
    console.log(`  ${minutes(Date.now() - t0).padStart(5)}  ${stage.padEnd(11)} ${hint}`);
  }
  if (stage === "online" || stage === "expired") break;
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const total = reached.online;
const row = {
  date: new Date().toISOString().slice(0, 10),
  client,
  toInstalled: reached.installed ?? (total !== undefined ? total : undefined),
  toOnline: total,
  result: total !== undefined ? (total <= 5 * 60_000 ? "under 5 min" : "over 5 min") : last === "expired" ? "code expired" : "not online in 30 min",
};
console.log(`\n${client}: ${row.result}${total !== undefined ? ` (${minutes(total)} total; command to CLI done ${row.toInstalled !== undefined ? minutes(row.toInstalled) : "?"}, CLI done to online ${row.toInstalled !== undefined ? minutes(total - row.toInstalled) : "?"})` : ""}`);

if (!existsSync(values.out)) {
  writeFileSync(values.out, [
    "# Connect timing",
    "",
    "Measured with `scripts/time-connect.mjs`: the clock starts when the command is shown and stops when the client itself connects (not just the CLI). See the checklist in `docs/planning/CONNECT_TIMING_CHECKLIST.md`.",
    "",
    "| Date | Client | Command → CLI done | CLI done → client online | Total | Result | Notes |",
    "|---|---|---|---|---|---|---|",
    "",
  ].join("\n"));
}
const cell = (ms) => (ms === undefined ? "—" : minutes(ms));
appendFileSync(values.out, `| ${row.date} | ${client} | ${cell(row.toInstalled)} | ${row.toInstalled !== undefined && total !== undefined ? minutes(total - row.toInstalled) : "—"} | ${cell(total)} | ${row.result} | ${values.note.replace(/\|/g, "/")} |\n`);
console.log(`Recorded in ${values.out}.`);
process.exit(total !== undefined ? 0 : 1);
