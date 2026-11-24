#!/usr/bin/env -S npx tsx
// Run one client's inbox smoke against a LOCALLY-BOOTED hub — no credential, no external service.
//
// WHY THIS EXISTS. The gate's capability 6 requires "a smoke run on a real install is recorded
// (command, output, date), and `opencadre doctor --client <tool>` reproduces it". The smoke harness
// (examples/clients/*-smoke.sh -> examples/clients/lib/inbox-smoke.mjs) needs a hub URL and an agent
// key; a key for a real hub is a credential that must never travel in a message or a file. So the
// reproducible form of that measurement is this: boot a hub in-process, mint an org and agents, and
// drive the REAL harness against it.
//
// WHAT IT PROVES AND WHAT IT DOES NOT. It proves the connect -> send -> receive -> reply path end to
// end, driven through the shipped harness against a real hub process. It does NOT evidence
// production TLS, the deployed hub's auth, or network behaviour. Recorded cells must say so.
//
// WHY tsx: src/ is TypeScript and no plain-node script imports it. Same reason console-shots.mjs
// runs under tsx.
//
// Usage:
//   npx tsx scripts/dev/client-smoke.ts                    # claude-code, rest mode
//   npx tsx scripts/dev/client-smoke.ts --client codex

import type { AddressInfo } from "node:net";
import { app } from "../../src/rest.js";
import { createOrganization, registerAgent } from "../../src/service.js";
import { runInboxSmoke } from "../../examples/clients/lib/inbox-smoke.mjs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const client = flag("--client", "claude-code");

const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { orgId } = createOrganization("Client Smoke Org");
const senderKey = registerAgent(orgId, "Smoke-Sender").apiKey;
const receiverKey = registerAgent(orgId, "Smoke-Receiver").apiKey;
// The REST path addresses `OPENCADRE_SUPERVISOR ?? "Supervisor"` (inbox-smoke.mjs), and the
// receive/reply steps run AS THE RECEIVER. So the send must go to the receiver, or receive peeks as
// the sender (0 messages) and reply has no thread. tests/client-examples-smoke.test.ts does the same.
process.env.OPENCADRE_SUPERVISOR = "Smoke-Receiver";

const result = await runInboxSmoke({ mode: "rest", client, restBaseUrl: base, senderKey, receiverKey });

console.log(`=== ${client} inbox smoke (${result.mode}) ===`);
for (const s of result.steps) console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name}: ${s.detail}`);
console.log(`RESULT: ${result.pass ? "PASS" : "FAIL"}`);
console.log(`steps: ${result.steps.map((s) => s.name).join(" -> ")}`);
console.log(`date:  ${new Date().toISOString()}`);
server.close();
process.exit(result.pass ? 0 : 1);
