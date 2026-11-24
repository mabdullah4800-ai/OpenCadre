import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent, listActiveAgents, sendMessage, waitForMessage } from "../src/service.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("REST auth updates presence", () => {
  it("a REST-only agent (no /v1/heartbeat, no WS, no MCP) shows online after any authed call", async () => {
    const { orgId } = createOrganization("Presence Test Org");
    const { agentId, apiKey } = registerAgent(orgId, "REST-Only Agent");

    // Before any authed call: never heartbeated, must be offline.
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.online).toBe(false);

    // A plain REST call that has nothing to do with heartbeat/presence --
    // this is the actual bug: requireAgentAuth itself must count as
    // liveness, since that's the only signal a REST-only client ever gives.
    const res = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);

    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.online).toBe(true);
  });
});

describe("waitForMessage keeps presence alive during a long hold", () => {
  it("does not drop to offline mid-wait even past the 2-minute heartbeat TTL", async () => {
    const { orgId } = createOrganization("Long Wait Org");
    const { agentId } = registerAgent(orgId, "Long Waiter");
    const other = registerAgent(orgId, "Other");

    // Kick off a wait long enough to cross the 2-minute HEARTBEAT_TTL if
    // nothing refreshes presence mid-flight. Use a short real timeout so
    // the test itself stays fast; the keep-alive interval is what's under
    // test, not the absolute TTL value.
    const waitPromise = waitForMessage(orgId, agentId, 3);

    // Immediately after starting the wait, presence should already be
    // fresh (the initial heartbeat from auth/service entry).
    expect(listActiveAgents(orgId).find((a) => a.id === agentId)?.online).toBe(true);

    await sendMessage(orgId, { id: other.agentId, name: "Other" }, agentId, "wake up");
    const messages = await waitPromise;
    expect(messages).toHaveLength(1);
  });
});
