import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Same routing as src/index.ts: MCP bypasses Express and parses its own body.
let server: http.Server;
let mcpUrl: URL;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  mcpUrl = new URL(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function connect(apiKey: string) {
  const client = new Client({ name: "tool-annotations-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}

type ListedTool = {
  name: string;
  title?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

describe("MCP tool annotations", () => {
  it("gives every tool a title and a readOnlyHint, and the hints match what the handlers do", async () => {
    const { orgId } = createOrganization("MCP Annotations Org");
    const client = await connect(registerAgent(orgId, "Claude A").apiKey);
    const tools = (await client.listTools()).tools as ListedTool[];

    expect(tools).toHaveLength(63);
    for (const tool of tools) {
      expect(tool.title, tool.name).toEqual(expect.any(String));
      expect(tool.title!.length, tool.name).toBeGreaterThan(0);
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe("boolean");
    }

    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.search_messages).toMatchObject({
      title: "Search Messages",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    // Advances the caller's awareness cursor and marks directed events delivered.
    expect(byName.get_awareness).toMatchObject({
      title: "Catch-Up Digest",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    });
    // A holder's repeat moves the lease forward from now.
    expect(byName.claim_task).toMatchObject({
      title: "Claim Task",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    });
    // A second complete does not write: the update only matches a task this caller still holds.
    expect(byName.complete_task).toMatchObject({
      title: "Complete Task",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    // A pending row is decided once; the same decision again changes nothing, and the decision is not additive.
    expect(byName.decide_approval).toMatchObject({
      title: "Decide Approval",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    });
    // Only the requester's own pending row changes, once; a repeat finds it withdrawn and changes nothing.
    expect(byName.withdraw_approval).toMatchObject({
      title: "Withdraw Approval Request",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    });
    // sweepTimeline can expire due approvals and announce lapsed leases, and pullEvents marks queued
    // deliveries delivered. Both writes are conditional, so a second pull of the same page changes nothing.
    expect(byName.pull_events).toMatchObject({
      title: "Pull Unacked Events",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    // null clears the declared budget, and any other value replaces it.
    expect(byName.set_round_budget).toMatchObject({
      title: "Declare Round Budget",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    });
    // A pending medium or high risk request is Web Pushed to the approver's phone.
    expect(byName.request_approval).toMatchObject({
      title: "Request Human Approval",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    });
    // Moves one task to the given lane (and rank): the same call again leaves it where it is.
    expect(byName.set_task_lane).toMatchObject({
      title: "Set Task Lane",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    // Replaces one stored value with the given one: setting the same cap again changes nothing.
    expect(byName.set_wip_cap).toMatchObject({
      title: "Set WIP Cap",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    });
    // The hub later POSTs to a URL the caller supplies. url=null clears the stored address.
    // Passing the same URL again stores the same one.
    expect(byName.register_webhook).toMatchObject({
      title: "Register Webhook",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    });

    await client.close();
  });
});
