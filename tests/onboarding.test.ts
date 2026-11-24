import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, sendMessage } from "../src/service.js";
import { requestApproval } from "../src/approvals.js";
import { SYSTEM_SENDER } from "../src/escalation.js";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const progress = async (key: string) =>
  (await (await fetch(`${base}/v1/onboarding`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
    steps: Array<{ id: string; done: boolean; doneAt: string | null; detail: string | null }>;
    completed: number;
    total: number;
  };
const doneIds = (p: Awaited<ReturnType<typeof progress>>) => p.steps.filter((s) => s.done).map((s) => s.id);

describe("first-run checklist", () => {
  it("starts empty: the Operator key and system notices don't count as progress", async () => {
    const { orgId } = createOrganization("Fresh Workspace");
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
    await sendMessage(orgId, SYSTEM_SENDER, "Operator", "HUB ALERT: something", "high");
    const p = await progress(operator.apiKey);
    expect(p).toMatchObject({ completed: 0, total: 4 });
    expect(p.steps.map((s) => s.id)).toEqual(["first_agent", "second_agent", "first_message", "first_clearance"]);
  });

  it("each step turns done when the real thing happens, with a short detail and no message content", async () => {
    const { orgId } = createOrganization("Walkthrough");
    const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });

    const claude = registerAgent(orgId, "Claude Code");
    expect(doneIds(await progress(operator.apiKey))).toEqual(["first_agent"]);

    registerAgent(orgId, "Codex");
    const two = await progress(operator.apiKey);
    expect(doneIds(two)).toEqual(["first_agent", "second_agent"]);
    expect(two.steps.slice(0, 2).map((s) => s.detail)).toEqual(["Claude Code", "Codex"]);

    await sendMessage(orgId, { id: claude.agentId, name: "Claude Code" }, "Codex", "a secret plan");
    const three = await progress(operator.apiKey);
    expect(three.steps[2]).toMatchObject({ done: true, detail: "Claude Code → Codex" });
    expect(JSON.stringify(three)).not.toContain("secret plan");

    await requestApproval(orgId, { id: claude.agentId, name: "Claude Code" }, { action: "rm -rf ./dist-old", category: "rm-rf", notifyOnly: true });
    const four = await progress(operator.apiKey);
    expect(four).toMatchObject({ completed: 4, total: 4 });
    expect(four.steps[3]).toMatchObject({ done: true, detail: "Claude Code · rm-rf (noted)" });
    expect(JSON.stringify(four)).not.toContain("dist-old");
    expect(four.steps.every((s) => typeof s.doneAt === "string")).toBe(true);
  });
});
