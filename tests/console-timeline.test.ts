import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, setAgentStatus, sendMessage } from "../src/service.js";
import { createTask } from "../src/tasks.js";
import { recordDecision } from "../src/events.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("Console Activity and checkpoint update UI Assets", () => {
  it("serves one Activity panel with its checkpoint updates", async () => {
    const res = await fetch(`${baseUrl}/app/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-tab="timeline"');
    expect(html).not.toContain('data-tab="awareness"');
    expect(html).toContain('data-panel="timeline"');
    expect(html).not.toContain('data-panel="awareness"');
    expect(html).toContain('id="timeline-filter"');
    expect(html).toContain('id="timeline-agent-filter"');
    expect(html).toContain('id="awareness-items"');
    expect(html).toContain('class="activity-updates"');
    expect(html).toContain('id="live-status"');
    expect(html).toContain('id="add-computer-form"');
  });

  it("describes the readable Activity log instead of an unexplained color bar", async () => {
    const res = await fetch(`${baseUrl}/app/`);
    const html = await res.text();
    // The heading subtitle restated Activity. "Since your last check" is the checkpoint list's own name.
    expect(html).not.toContain("What changed across your workspace");
    expect(html).toContain("Since your last check");
    expect(html).toContain('<option value="decision.recorded">Decisions</option>');
  });
  it("serves app.js containing timeline and awareness render logic", async () => {
    const res = await fetch(`${baseUrl}/app/app.js`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("renderTimeline");
    expect(js).toContain("renderAwareness");
    expect(js).toContain("summarizeEvent");
    expect(js).toContain("ackDigestEvent");
    expect(js).toContain("connectLiveWs");
    expect(js).toContain("renderDeliveryTracker");
    expect(js).toContain("add-computer-form");
  });

  it("serves app.css containing timeline and awareness styling rules", async () => {
    const res = await fetch(`${baseUrl}/app/app.css`);
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain(".timeline-controls");
    expect(css).toContain(".awareness-summary");
    expect(css).toContain(".p-badge");
    expect(css).toContain(".bg-pill");
    expect(css).toContain(".ack-actions");
    expect(css).toContain(".rail-dot");
    expect(css).toContain(".delivery-tracker");
    expect(css).toContain(".live-status");
    expect(css).toContain(".connect-flow");
  });

  it("serves the V5 mobile layout for Activity rows", async () => {
    const res = await fetch(`${baseUrl}/app/console-v2.css`);
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain(".activity-entry-action { grid-column: 2;");
    expect(css).toContain(".strip.timeline-entry { grid-template-columns: 18px minmax(0, 1fr); }");
  });
});

describe("Console Timeline and Awareness REST API Integration", () => {
  it("delivers timeline events for console consumption", async () => {
    const { orgId } = createOrganization("Console Test Org");
    const agentA = registerAgent(orgId, "Agent-A");
    const agentB = registerAgent(orgId, "Agent-B");

    createTask(orgId, { id: agentA.agentId, name: "Agent-A" }, { title: "Refactor database client" });
    setAgentStatus(orgId, agentA.agentId, "Refactoring", ["src/db.ts"], "editing");
    recordDecision(orgId, { id: agentA.agentId, name: "Agent-A" }, { title: "Use WAL mode", rationale: "Concurrency" });
    await sendMessage(orgId, { id: agentA.agentId, name: "Agent-A" }, "Agent-B", "Check the new task", "high");

    const res = await fetch(`${baseUrl}/v1/events?limit=10`, {
      headers: { authorization: `Bearer ${agentB.apiKey}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toBeDefined();
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThanOrEqual(4);

    const types = data.events.map((e: { type: string }) => e.type);
    expect(types).toContain("task.created");
    expect(types).toContain("agent.phase_changed");
    expect(types).toContain("decision.recorded");
    expect(types).toContain("message.sent");
  });

  it("surfaces awareness digest and allows acking directed items", async () => {
    const { orgId } = createOrganization("Awareness Test Org");
    const sender = registerAgent(orgId, "Sender");
    const recipient = registerAgent(orgId, "Recipient");

    await sendMessage(orgId, { id: sender.agentId, name: "Sender" }, "Recipient", "Urgent security check", "high");

    const res = await fetch(`${baseUrl}/v1/awareness`, {
      headers: { authorization: `Bearer ${recipient.apiKey}` },
    });
    expect(res.status).toBe(200);
    const digest = await res.json();
    expect(digest.items).toBeDefined();
    expect(digest.items.length).toBeGreaterThanOrEqual(1);

    const p1Item = digest.items.find((i: { priority: number; directed: boolean }) => i.priority === 1 && i.directed);
    expect(p1Item).toBeDefined();

    const ackRes = await fetch(`${baseUrl}/v1/events/${p1Item.seq}/ack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${recipient.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ outcome: "acted" }),
    });
    expect(ackRes.status).toBe(200);
    const ackData = await ackRes.json();
    expect(ackData.delivery.state).toBe("acted");

    const refreshed = await (await fetch(`${baseUrl}/v1/awareness`, {
      headers: { authorization: `Bearer ${recipient.apiKey}` },
    })).json();
    const remainingP1 = refreshed.items.filter((i: { seq: number }) => i.seq === p1Item.seq);
    expect(remainingP1.length).toBe(0);
  });
});
