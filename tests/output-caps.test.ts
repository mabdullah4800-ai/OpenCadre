import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { recordDecision } from "../src/events.js";
import { claimTask, createTask } from "../src/tasks.js";
import { requestApproval } from "../src/approvals.js";
import {
  askClarification, createOrganization, getMessages, registerAgent, reply, sendMessage, shareFile,
} from "../src/service.js";

// Every connected agent pays tokens for tool output, so unbounded lists and
// payloads are capped at the MCP layer while REST keeps its full defaults.

let mcpServer: http.Server;
let mcpUrl: URL;
let restServer: ReturnType<typeof app.listen>;
let baseUrl: string;

beforeAll(async () => {
  mcpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, resolve));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);

  restServer = app.listen(0);
  await new Promise((r) => restServer.once("listening", r));
  baseUrl = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restServer.close();
  // A failed assertion skips client.close(), so drop lingering connections rather than hang.
  mcpServer.closeAllConnections();
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
});

async function connect(apiKey: string) {
  const client = new Client({ name: "output-caps-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return { orgId, a: { id: a.agentId, name: "Agent A", key: a.apiKey }, b: { id: b.agentId, name: "Agent B", key: b.apiKey } };
}

async function sendMany(orgId: string, from: { id: string; name: string }, n: number) {
  for (let i = 1; i <= n; i++) await sendMessage(orgId, from, "Agent B", `msg ${i}`);
}

describe("message limits", () => {
  it("getMessages returns the oldest N, marks only those read, and the next call gets the rest", async () => {
    const { orgId, a, b } = setup("Limit Service Org");
    await sendMany(orgId, a, 3);

    expect(getMessages(orgId, b.id, undefined, { limit: 2 }).map((m) => m.body)).toEqual(["msg 1", "msg 2"]);
    expect(getMessages(orgId, b.id).map((m) => m.body)).toEqual(["msg 3"]);
    expect(getMessages(orgId, b.id)).toHaveLength(0);
  });

  it("get_messages defaults to 20 and says how much unread mail remains", async () => {
    const { orgId, a, b } = setup("Limit MCP Org");
    await sendMany(orgId, a, 22);
    const client = await connect(b.key);

    const first = text(await client.callTool({ name: "get_messages", arguments: {} }));
    expect(first).toMatch(/^20 message\(s\):/);
    expect(first).toContain("msg 20");
    expect(first).not.toContain("msg 21");
    expect(first.endsWith("(2 more unread -- call again)")).toBe(true);

    const second = text(await client.callTool({ name: "get_messages", arguments: { limit: 1 } }));
    expect(second).toContain("msg 21");
    expect(second.endsWith("(1 more unread -- call again)")).toBe(true);

    const last = text(await client.callTool({ name: "get_messages", arguments: {} }));
    expect(last).toContain("msg 22");
    expect(last).not.toContain("more unread");
    await client.close();
  });

  it("a peek does not count the returned mail as remaining", async () => {
    const { orgId, a, b } = setup("Limit Peek Org");
    await sendMany(orgId, a, 3);
    const client = await connect(b.key);

    const peeked = text(await client.callTool({ name: "get_messages", arguments: { limit: 2, peek: true } }));
    expect(peeked.endsWith("(1 more unread -- call again)")).toBe(true);
    expect(getMessages(orgId, b.id, undefined, { peek: true })).toHaveLength(3);
    await client.close();
  });

  it("wait_for_message passes the limit through", async () => {
    const { orgId, a, b } = setup("Limit Wait Org");
    await sendMany(orgId, a, 3);
    const client = await connect(b.key);

    const out = text(await client.callTool({ name: "wait_for_message", arguments: { timeoutSeconds: 1, limit: 2 } }));
    expect(out).toMatch(/^2 message\(s\):/);
    expect(out.endsWith("(1 more unread -- call again)")).toBe(true);
    expect(getMessages(orgId, b.id).map((m) => m.body)).toEqual(["msg 3"]);
    await client.close();
  });

  it("REST accepts a clamped limit and defaults to no limit", async () => {
    const { orgId, a, b } = setup("Limit REST Org");
    await sendMany(orgId, a, 25);
    const get = async (path: string) =>
      ((await (await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${b.key}` } })).json()) as { messages: Array<{ body: string }> }).messages;

    expect((await get("/v1/messages?limit=2")).map((m) => m.body)).toEqual(["msg 1", "msg 2"]);
    expect(await get("/v1/messages?limit=0")).toHaveLength(1);
    expect((await get("/v1/messages/wait?timeoutSeconds=1&limit=1")).map((m) => m.body)).toEqual(["msg 4"]);
    expect(await get("/v1/messages")).toHaveLength(21);
  });
});

describe("message body cap", () => {
  const tooLong = "x".repeat(16001);
  const error = "message body exceeds 16000 characters";

  it("sendMessage, askClarification and reply reject oversized bodies and store nothing", async () => {
    const { orgId, a, b } = setup("Body Cap Org");
    expect(await sendMessage(orgId, a, "Agent B", tooLong)).toEqual({ ok: false, error });
    expect(await askClarification(orgId, a, "Agent B", tooLong, 0.1)).toEqual({ ok: false, error });
    expect(getMessages(orgId, b.id, undefined, { peek: true })).toHaveLength(0);

    expect((await sendMessage(orgId, a, "Agent B", "x".repeat(16000))).ok).toBe(true);
    const [received] = getMessages(orgId, b.id);
    expect(reply(orgId, b, received.thread_id, tooLong)).toEqual({ ok: false, error });
    expect(getMessages(orgId, a.id, undefined, { peek: true })).toHaveLength(0);
  });

  it("shareFile rejects an oversized message without storing the file", async () => {
    const { orgId, a } = setup("Body Cap Share Org");
    const result = await shareFile(orgId, a, "Agent B", "notes.md", "text/markdown", Buffer.from("# hi"), tooLong);
    expect(result).toEqual({ ok: false, error });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE org_id = ?`).get(orgId)).toEqual({ n: 0 });
  });

  it("REST returns 400 and MCP returns an Error line", async () => {
    const { a } = setup("Body Cap Surface Org");
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await post("/v1/messages", { toAgent: "Agent B", body: tooLong });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error });
    expect((await post("/v1/questions", { toAgent: "Agent B", body: tooLong, timeoutSeconds: 0.1 })).status).toBe(400);

    const client = await connect(a.key);
    expect(text(await client.callTool({ name: "send_message", arguments: { toAgent: "Agent B", body: tooLong } }))).toBe(`Error: ${error}`);
    await client.close();
  });
});

describe("timeline caps", () => {
  it("get_timeline defaults to 30 events and truncates long payloads", async () => {
    const { orgId, a } = setup("Timeline Cap Org");
    for (let i = 0; i < 34; i++) recordDecision(orgId, a, { title: `decision ${i}` });
    recordDecision(orgId, a, { title: "long one", rationale: "r".repeat(1000) });
    const client = await connect(a.key);

    expect(text(await client.callTool({ name: "get_timeline", arguments: {} })).split("\n")).toHaveLength(30);
    const all = text(await client.callTool({ name: "get_timeline", arguments: { limit: 100 } })).split("\n");
    expect(all).toHaveLength(35);
    const long = all[all.length - 1];
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("r".repeat(300));
    expect(all[0].endsWith("…")).toBe(false);
    await client.close();
  });

  // Without a cursor an agent wants what is happening now, not the org's first events ever.
  it("get_timeline without after returns the latest events, in order", async () => {
    const { orgId, a } = setup("Timeline Latest Org");
    for (let i = 0; i < 40; i++) recordDecision(orgId, a, { title: `decision ${i}` });
    const client = await connect(a.key);
    const lines = text(await client.callTool({ name: "get_timeline", arguments: { limit: 3 } })).split("\n");
    expect(lines.map((l) => l.match(/decision (\d+)/)?.[1])).toEqual(["37", "38", "39"]);
    const after = Number(lines[0].match(/^#(\d+)/)![1]) - 2;
    const paged = text(await client.callTool({ name: "get_timeline", arguments: { after, limit: 1 } }));
    expect(paged).toContain("decision 36");
    await client.close();
  });
});

describe("approval notices under the body cap", () => {
  // requestApproval ignores sendMessage's result, so an oversized notice used to vanish silently.
  it("still reaches the approver when details are huge, with details truncated", async () => {
    const { orgId, a, b } = setup("Approval Notice Org");
    await requestApproval(orgId, { id: a.id, name: a.name }, { action: "deploy prod", details: "d".repeat(20000), approver: "Agent B" });
    const [notice] = getMessages(orgId, b.id, undefined, { peek: true });
    expect(notice.body).toContain("APPROVAL NEEDED");
    expect(notice.body).toContain("Approval id:");
    expect(notice.body.length).toBeLessThan(16000);
  });
});

describe("task and approval list caps", () => {
  it("list_tasks shows the most recent 25 with a note, and truncates long summaries", async () => {
    const { orgId, a } = setup("Task Cap Org");
    for (let i = 1; i <= 27; i++) createTask(orgId, a, { title: `task ${String(i).padStart(2, "0")}` });
    const client = await connect(a.key);

    const lines = text(await client.callTool({ name: "list_tasks", arguments: {} })).split("\n");
    expect(lines).toHaveLength(26);
    expect(lines[0]).toContain("task 03");
    expect(lines[24]).toContain("task 27");
    expect(lines[25]).toBe("(showing 25 of 27 tasks -- pass status or a higher limit)");
    expect(text(await client.callTool({ name: "list_tasks", arguments: { limit: 30 } }))).not.toContain("showing");

    const task = createTask(orgId, a, { title: "summarized" });
    claimTask(orgId, a, task.id);
    const done = text(await client.callTool({ name: "complete_task", arguments: { taskId: task.id, summary: "s".repeat(400) } }));
    expect(done).toContain(`result: ${"s".repeat(150)}…`);
    expect(done).not.toContain("s".repeat(151));
    await client.close();
  });

  it("list_approvals shows 25 by default with a note", async () => {
    const { orgId, a } = setup("Approval Cap Org");
    for (let i = 1; i <= 27; i++) await requestApproval(orgId, a, { action: `deploy ${i}` });
    const client = await connect(a.key);

    const lines = text(await client.callTool({ name: "list_approvals", arguments: {} })).split("\n");
    expect(lines).toHaveLength(26);
    expect(lines[0]).toContain("deploy 27");
    expect(lines[25]).toBe("(showing 25 of 27 approval requests -- pass status or a higher limit)");
    expect(text(await client.callTool({ name: "list_approvals", arguments: { limit: 2 } })).split("\n")).toHaveLength(3);
    await client.close();
  });
});

describe("get_active_agents and descriptions", () => {
  it("caps each agent's editing list at 5 files", async () => {
    const { a } = setup("Editing Cap Org");
    const client = await connect(a.key);
    const files = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    await client.callTool({ name: "set_status", arguments: { task: "wide edit", files } });

    const out = text(await client.callTool({ name: "get_active_agents", arguments: {} }));
    expect(out).toContain("editing: f1, f2, f3, f4, f5 +2 more");
    expect(out).not.toContain("f6");
    await client.close();
  });

  it("keeps the coordination note on set_status only", async () => {
    const { a } = setup("Description Org");
    const client = await connect(a.key);
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description!;
    const note = "Convention: call this proactively";

    expect(description("send_message")).not.toContain(note);
    expect(description("share_file")).not.toContain(note);
    expect(description("broadcast_message")).not.toContain(note);
    expect(description("set_status")).toContain(note);
    await client.close();
  });
});
