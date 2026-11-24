import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { recordDecision } from "../src/events.js";
import { createOrganization, registerAgent } from "../src/service.js";

// The console reads the timeline over REST without a cursor. Paging from the org's first
// event meant a busy org's Timeline panel only ever showed its oldest events.
let baseUrl: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function orgWithEvents(n: number) {
  const { orgId } = createOrganization(`Latest Events Org ${n}`);
  const agent = registerAgent(orgId, "Timeline-Reader");
  for (let i = 0; i < n; i++) recordDecision(orgId, { id: agent.agentId, name: "Timeline-Reader" }, { title: `decision ${i}` });
  return agent.apiKey;
}

const titles = async (key: string, query: string) => {
  const res = await fetch(`${baseUrl}/v1/events?${query}`, { headers: { authorization: `Bearer ${key}` } });
  const { events } = (await res.json()) as { events: Array<{ seq: number; payload: string }> };
  return { seqs: events.map((e) => e.seq), titles: events.map((e) => JSON.parse(e.payload).title) };
};

describe("GET /v1/events ordering", () => {
  it("without a cursor returns the newest events, in ascending seq order", async () => {
    const key = orgWithEvents(12);
    const { seqs, titles: t } = await titles(key, "limit=5");
    expect(t).toEqual(["decision 7", "decision 8", "decision 9", "decision 10", "decision 11"]);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("latest=true behaves the same, and latest=false pages from the start", async () => {
    const key = orgWithEvents(8);
    expect((await titles(key, "limit=3&latest=true")).titles).toEqual(["decision 5", "decision 6", "decision 7"]);
    expect((await titles(key, "limit=3&latest=false")).titles).toEqual(["decision 0", "decision 1", "decision 2"]);
  });

  it("with an after cursor still pages forward from that cursor", async () => {
    const key = orgWithEvents(6);
    const all = await titles(key, "limit=6");
    const { titles: t } = await titles(key, `after=${all.seqs[1]}&limit=2`);
    expect(t).toEqual(["decision 2", "decision 3"]);
  });
});
