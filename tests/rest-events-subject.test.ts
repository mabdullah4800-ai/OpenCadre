import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { claimTask, createTask } from "../src/tasks.js";

// One subject's history, for the console's task history. Before this, the console read the newest 200 task events of
// the whole workspace and filtered them itself, so in a busy workspace a task's early events fell outside that page
// and its history showed partial or empty (Codex-OpenCadre-f46c on 492aa5e).
let baseUrl: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const get = async (key: string, query: string) => {
  const res = await fetch(`${baseUrl}/v1/events?${query}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as { events?: Array<{ type: string; subject_id: string }> } };
};

describe("GET /v1/events?subjectType=&subjectId=", () => {
  it("returns one task's events from its start, however many other task events came after", async () => {
    const { orgId } = createOrganization("Subject History Org");
    const agent = registerAgent(orgId, "History-Reader");
    const actor = { id: agent.agentId, name: "History-Reader" };
    const task = createTask(orgId, actor, { title: "The old task" });
    expect(claimTask(orgId, actor, task.id).ok).toBe(true);
    for (let i = 0; i < 230; i++) createTask(orgId, actor, { title: `busy ${i}` }); // 230 newer task events, none of them this task's

    const newest = await get(agent.apiKey, "types=task.created,task.claimed&limit=200");
    expect(newest.body.events!.some((e) => e.subject_id === task.id)).toBe(false); // the old read could not see it

    const mine = await get(agent.apiKey, `subjectType=task&subjectId=${task.id}&latest=false`);
    expect(mine.status).toBe(200);
    expect(mine.body.events!.map((e) => e.type)).toEqual(["task.created", "task.claimed"]);
    expect(mine.body.events!.every((e) => e.subject_id === task.id)).toBe(true);
  });

  it("refuses one of the pair without the other", async () => {
    const { orgId } = createOrganization("Subject Pair Org");
    const agent = registerAgent(orgId, "Pair-Reader");
    expect((await get(agent.apiKey, "subjectType=task")).status).toBe(400);
    expect((await get(agent.apiKey, "subjectId=abc")).status).toBe(400);
  });

  it("stays inside the reader's workspace", async () => {
    const a = createOrganization("Subject Org A");
    const b = createOrganization("Subject Org B");
    const writer = registerAgent(a.orgId, "Writer");
    const reader = registerAgent(b.orgId, "Reader");
    const task = createTask(a.orgId, { id: writer.agentId, name: "Writer" }, { title: "private" });
    expect((await get(reader.apiKey, `subjectType=task&subjectId=${task.id}&latest=false`)).body.events).toEqual([]);
  });
});
