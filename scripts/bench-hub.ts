// Hub load benchmark (reliability sprint R2). Starts the real REST app in this process on a scratch database,
// creates orgs and agents, and drives real HTTP traffic: every receiver holds a /v1/messages/wait long-poll
// while senders fire messages concurrently. Reports send latency, end-to-end delivery latency, errors,
// duplicates and lost messages as JSON.
//
//   node --import tsx scripts/bench-hub.ts --orgs 4 --agents 6 --messages 600 --concurrency 40
//
// Numbers are for this machine and a single process; record them with the hardware in docs/planning/BENCHMARKS.md.
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { values } = parseArgs({
  options: {
    orgs: { type: "string", default: "4" },
    agents: { type: "string", default: "6" },
    messages: { type: "string", default: "600" },
    concurrency: { type: "string", default: "40" },
  },
});
const ORGS = Number(values.orgs);
const AGENTS = Number(values.agents);
const MESSAGES = Number(values.messages);
const CONCURRENCY = Number(values.concurrency);

export interface BenchResult {
  orgs: number;
  agentsPerOrg: number;
  messages: number;
  concurrency: number;
  wallSeconds: number;
  sendsPerSecond: number;
  errors: number;
  duplicates: number;
  lost: number;
  sendMs: { p50: number; p95: number; p99: number };
  deliveryMs: { p50: number; p95: number; p99: number };
}

export async function runBench(orgs = ORGS, agentsPerOrg = AGENTS, messages = MESSAGES, concurrency = CONCURRENCY): Promise<BenchResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencadre-bench-"));
  process.env.OPENCADRE_DB_PATH ??= path.join(dir, "bench.db");
  process.env.OPENCADRE_RATE_LIMIT_PER_MIN = "1000000";
  process.env.OPENCADRE_LOG_LEVEL ??= "error";
  const { app } = await import("../src/rest.js");
  const { createOrganization, registerAgent } = await import("../src/service.js");

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const fleet = Array.from({ length: orgs }, (_, o) => {
    const { orgId } = createOrganization(`Bench Org ${o}`);
    return {
      orgId,
      agents: Array.from({ length: agentsPerOrg }, (_, a) => ({ name: `Bench-${o}-${a}`, key: registerAgent(orgId, `Bench-${o}-${a}`).apiKey })),
    };
  });

  const sentAt = new Map<string, number>();
  const deliveredAt = new Map<string, number>();
  let duplicates = 0;
  let errors = 0;
  let sending = true;

  const receive = async (key: string) => {
    while (sending || deliveredAt.size < sentAt.size) {
      try {
        const res = await fetch(`${base}/v1/messages/wait?timeoutSeconds=2`, { headers: { authorization: `Bearer ${key}` } });
        const { messages: rows = [] } = (await res.json()) as { messages?: Array<{ body: string }> };
        const now = performance.now();
        for (const row of rows) {
          if (deliveredAt.has(row.body)) duplicates++;
          else deliveredAt.set(row.body, now);
        }
      } catch {
        errors++;
      }
      if (!sending && deliveredAt.size >= sentAt.size) return;
    }
  };
  const receivers = fleet.flatMap((org) => org.agents.map((agent) => receive(agent.key)));

  const sendLatencies: number[] = [];
  let next = 0;
  const started = performance.now();
  const sender = async () => {
    for (;;) {
      const i = next++;
      if (i >= messages) return;
      const org = fleet[i % orgs];
      const from = org.agents[i % agentsPerOrg];
      const to = org.agents[(i + 1) % agentsPerOrg];
      const token = `bench-${i}`;
      const t0 = performance.now();
      sentAt.set(token, t0);
      try {
        const res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${from.key}`, "content-type": "application/json", "idempotency-key": `bench-key-${i}` },
          body: JSON.stringify({ toAgent: to.name, body: token, priority: "low" }),
        });
        if (res.status !== 201) errors++;
        await res.arrayBuffer();
      } catch {
        errors++;
      }
      sendLatencies.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, sender));
  const sendDone = performance.now();
  sending = false;
  const deadline = Date.now() + 15_000;
  while (deliveredAt.size < sentAt.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await Promise.race([Promise.all(receivers), new Promise((r) => setTimeout(r, 3000))]);
  server.close();

  const pct = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 10) / 10;
  };
  const delivery = [...deliveredAt.entries()].map(([token, at]) => at - (sentAt.get(token) ?? at));
  return {
    orgs,
    agentsPerOrg,
    messages,
    concurrency,
    wallSeconds: Math.round((sendDone - started) / 100) / 10,
    sendsPerSecond: Math.round(messages / ((sendDone - started) / 1000)),
    errors,
    duplicates,
    lost: sentAt.size - deliveredAt.size,
    sendMs: { p50: pct(sendLatencies, 50), p95: pct(sendLatencies, 95), p99: pct(sendLatencies, 99) },
    deliveryMs: { p50: pct(delivery, 50), p95: pct(delivery, 95), p99: pct(delivery, 99) },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "bench-hub.ts"))) {
  runBench().then((r) => {
    console.log(JSON.stringify({ ...r, node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length }, null, 2));
    process.exit(0);
  });
}
