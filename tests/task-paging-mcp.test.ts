import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";
import { db } from "../src/db.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { invalidateScopes } from "../src/scope.js";

/** MCP list_tasks after tranche 2 (plan 2026-09-30-task-paging.md §0 item 7): the newest N are chosen in SQL
 * (DESC LIMIT, then reversed), with the same selection, order and total as before; the superseded marker is new. */

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
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));

async function connect(apiKey: string) {
  const client = new Client({ name: "task-paging-mcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
}
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

let n = 0;
function put(orgId: string, creator: { agentId: string }, row: Record<string, unknown>): string {
  const id = `mcp-task-${++n}`;
  const full = { id, org_id: orgId, title: `Task ${id}`, status: "open", created_by_agent_id: creator.agentId, created_by_agent_name: "Ada", created_at: "2026-09-01 10:00:00", updated_at: "2026-09-01 10:00:00", ...row };
  const cols = Object.keys(full);
  db.prepare(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(full));
  return id;
}
const lineIds = (out: string) => [...out.matchAll(/\(id ([^)]+)\)/g)].map((m) => m[1]).filter((id) => id.startsWith("mcp-task-"));

describe("get_task recovers full completion evidence and correction notes", () => {
  const snapshot = (taskId: string) => ({
    task: db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId),
    votes: db.prepare("SELECT * FROM task_reviews WHERE task_id = ? ORDER BY reviewer_agent_id").all(taskId),
  });

  it("recovers an existing-worker review/correction flow after reconnect without changing task state", async () => {
    const { orgId } = createOrganization("MCP Evidence Recovery Org");
    const builder = registerAgent(orgId, "Builder");
    const reviewer = registerAgent(orgId, "Reviewer");
    const a = await connect(builder.apiKey);
    const b = await connect(reviewer.apiKey);
    let resumed: Client | undefined;
    try {
      const created = text(await a.callTool({ name: "create_task", arguments: { title: "Evidence recovery fixture", requiredReviews: 2 } }));
      const taskId = created.match(/\(id ([^)]+)\)/)![1];
      await a.callTool({ name: "claim_task", arguments: { taskId } });
      // Synthetic evidence packets, not a claim of a real peer-review pilot.
      const packet = `${"Build evidence. ".repeat(20)}\nFrozen receipt: https://example.invalid/review/first#artifact-digest`;
      const correction = `${"Review finding. ".repeat(20)}\nCorrection required: recover persisted evidence after context loss.`;
      const completed = text(await a.callTool({ name: "complete_task", arguments: { taskId, summary: packet } }));
      expect(completed).not.toContain("first#artifact-digest");
      const beforeReviewRead = snapshot(taskId);
      const detail = text(await b.callTool({ name: "get_task", arguments: { taskId } }));
      expect(detail).toContain(packet);
      expect(snapshot(taskId)).toEqual(beforeReviewRead);
      expect(text(await b.callTool({ name: "list_tasks", arguments: {} }))).not.toContain("first#artifact-digest");

      // A partial vote must survive a read; only the explicit rejection clears it.
      await b.callTool({ name: "accept_task", arguments: { taskId } });
      const withVote = snapshot(taskId);
      expect(withVote.votes).toHaveLength(1);
      await b.callTool({ name: "get_task", arguments: { taskId } });
      expect(snapshot(taskId)).toEqual(withVote);
      const rejected = text(await b.callTool({ name: "reject_task", arguments: { taskId, note: correction } }));
      expect(rejected).not.toContain("recover persisted evidence");
      await a.close();
      resumed = await connect(builder.apiKey);
      const beforeCorrectionRead = snapshot(taskId);
      const recovered = text(await resumed.callTool({ name: "get_task", arguments: { taskId } }));
      expect(recovered).toContain(packet);
      expect(recovered).toContain(correction);
      expect(recovered).toMatch(/^\[claimed\]/);
      expect(recovered).toContain("claimed by Builder");
      expect(snapshot(taskId)).toEqual(beforeCorrectionRead);
      expect(beforeCorrectionRead.votes).toHaveLength(0);
      expect(text(await resumed.callTool({ name: "list_tasks", arguments: {} }))).not.toContain("recover persisted evidence");

      const freshPacket = `${"Correction evidence. ".repeat(20)}\nFrozen receipt: https://example.invalid/review/corrected#new-digest`;
      await resumed.callTool({ name: "complete_task", arguments: { taskId, summary: freshPacket } });
      const corrected = text(await b.callTool({ name: "get_task", arguments: { taskId } }));
      expect(corrected).toContain(freshPacket);
      expect(corrected).not.toContain(packet);
      expect(corrected).not.toContain(correction);
      expect(corrected).toContain("0/2 reviews");
    } finally {
      await Promise.all([a.close(), b.close(), resumed?.close()]);
    }
  });

  // There is no field-size maximum in the existing store/schema. These are measured
  // cases around the old display cutoff and a larger stored value, not a new limit.
  it.each([150, 151, 65_536])("returns every stored character at length %i while the board remains compact", async (length) => {
    const { orgId } = createOrganization(`MCP Detail Length ${length}`);
    const a = registerAgent(orgId, "Ada");
    const summary = "s".repeat(length - 1) + "Z";
    const note = "n".repeat(length - 1) + "Y";
    const taskId = put(orgId, a, { completion_summary: summary, review_note: note });
    const client = await connect(a.apiKey);
    try {
      expect(text(await client.callTool({ name: "get_task", arguments: { taskId } })))
        .toBe(`[open] Task ${taskId} (id ${taskId}) | result: ${summary} | rejection note: ${note}`);
      const compact = (value: string) => length > 150 ? value.slice(0, 150) + "…" : value;
      expect(text(await client.callTool({ name: "list_tasks", arguments: {} })))
        .toBe(`[open] Task ${taskId} (id ${taskId}) | result: ${compact(summary)} | rejection note: ${compact(note)}`);
    } finally { await client.close(); }
  });

  it("masks legacy stored secrets beyond the cutoff and denies project and organization outsiders", async () => {
    const { orgId } = createOrganization("MCP Private Evidence Org");
    const a = registerAgent(orgId, "Ada");
    const outsider = registerAgent(orgId, "Project Outsider");
    for (const key of ["github.com/acme/alpha", "github.com/acme/beta"]) {
      db.prepare("INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, 1)").run(orgId, key, key);
    }
    db.prepare("UPDATE agents SET scope = 'project', home_project = 'github.com/acme/alpha' WHERE id = ?").run(outsider.agentId);
    db.prepare("UPDATE organizations SET project_isolation = 1 WHERE id = ?").run(orgId);
    invalidateScopes();
    // Deliberately fake, not a live key; direct insertion also exercises legacy read-time masking.
    const fakeCredential = "synthetic-credential-for-masking-test";
    const prefix = "Benign evidence. ".repeat(20);
    const taskId = put(orgId, a, {
      project_key: "github.com/acme/beta",
      completion_summary: `${prefix}Authorization: Bearer ${fakeCredential}\nEVIDENCE_TAIL`,
      review_note: `${prefix}PASSWORD=${fakeCredential}\nCORRECTION_TAIL`,
    });
    const { orgId: otherOrg } = createOrganization("MCP Other Evidence Org");
    const clients = await Promise.all([connect(a.apiKey), connect(outsider.apiKey), connect(registerAgent(otherOrg, "Org Outsider").apiKey)]);
    try {
      const before = snapshot(taskId);
      const visible = text(await clients[0].callTool({ name: "get_task", arguments: { taskId } }));
      expect(visible).toContain("EVIDENCE_TAIL");
      expect(visible).toContain("CORRECTION_TAIL");
      expect(visible).toContain("Bearer ***");
      expect(visible).toContain("PASSWORD=***");
      expect(visible).not.toContain(fakeCredential);
      for (const client of clients.slice(1)) {
        expect(text(await client.callTool({ name: "get_task", arguments: { taskId } })))
          .toBe(`Error: No task found matching "${taskId}"`);
        const board = text(await client.callTool({ name: "list_tasks", arguments: {} }));
        expect(board).not.toContain("EVIDENCE_TAIL");
        expect(board).not.toContain("CORRECTION_TAIL");
      }
      expect(snapshot(taskId)).toEqual(before);
    } finally { await Promise.all(clients.map((c) => c.close())); }
  });
});

describe("list_tasks chooses the newest in SQL and keeps selection, order and total", () => {
  it("default: the newest 25 by (created_at, insertion), shown oldest first, with the total", async () => {
    const { orgId } = createOrganization("MCP Paging Org");
    const a = registerAgent(orgId, "Ada");
    // Out-of-order timestamps and a block of identical ones, so insertion order alone would give the wrong answer.
    const ids: Array<{ id: string; at: string }> = [];
    for (let i = 0; i < 30; i++) {
      const at = i < 10 ? "2026-09-01 12:00:00" : `2026-09-01 1${i % 2 ? 1 : 3}:00:${String(i).padStart(2, "0")}`;
      ids.push({ id: put(orgId, a, { title: `t${i}`, created_at: at }), at });
    }
    const expected = ids.map((r, i) => ({ ...r, i })).sort((x, y) => (x.at === y.at ? x.i - y.i : x.at < y.at ? -1 : 1)).map((r) => r.id);
    const client = await connect(a.apiKey);
    const out = text(await client.callTool({ name: "list_tasks", arguments: {} }));
    expect(lineIds(out)).toEqual(expected.slice(-25));
    expect(out.split("\n").at(-1)).toBe("(showing 25 of 30 tasks -- pass status or a higher limit)");
    const three = text(await client.callTool({ name: "list_tasks", arguments: { limit: 3 } }));
    expect(lineIds(three)).toEqual(expected.slice(-3));
    const all = text(await client.callTool({ name: "list_tasks", arguments: { limit: 200 } }));
    expect(lineIds(all)).toEqual(expected);
    expect(all).not.toContain("showing");
    await client.close();
  });

  it("status and limit are applied in SQL: the statement is limited and never reads more rows than it shows", async () => {
    const { orgId } = createOrganization("MCP Paging SQL Org");
    const a = registerAgent(orgId, "Ada");
    for (let i = 0; i < 40; i++) put(orgId, a, { title: `open ${i}`, created_at: `2026-09-01 10:00:${String(i).padStart(2, "0")}` });
    for (let i = 0; i < 5; i++) put(orgId, a, { title: `done ${i}`, status: "done", claimed_by_agent_id: a.agentId, claimed_by_agent_name: "Ada", completed_at: "2026-09-02 10:00:00", created_at: `2026-09-01 11:00:0${i}` });
    const client = await connect(a.apiKey);
    const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as { all: (...a: unknown[]) => unknown[] };
    const original = proto.all;
    const reads: Array<{ sql: string; rows: number }> = [];
    proto.all = function (this: { source: string }, ...args: unknown[]) {
      const rows = original.apply(this, args);
      if (/FROM tasks/.test(this.source)) reads.push({ sql: this.source, rows: rows.length });
      return rows;
    };
    let out: string;
    try {
      out = text(await client.callTool({ name: "list_tasks", arguments: { status: "open", limit: 4 } }));
    } finally {
      proto.all = original;
    }
    expect(out.split("\n").filter((l) => l.startsWith("[open]")).map((l) => l.match(/\] (open \d+)/)![1])).toEqual(["open 36", "open 37", "open 38", "open 39"]);
    expect(out.split("\n").at(-1)).toBe("(showing 4 of 40 tasks -- pass status or a higher limit)");
    const listing = reads.filter((r) => /ORDER BY/.test(r.sql) && /LIMIT/.test(r.sql) && !/lease_expiry_emitted_at IS NULL/.test(r.sql));
    expect(listing.length).toBe(1);
    expect(listing[0].sql).toMatch(/DESC/);
    expect(listing[0].rows).toBe(4);
    expect(Math.max(...reads.map((r) => r.rows))).toBeLessThanOrEqual(4);
    await client.close();
  });
});

describe("list_tasks marks a superseded row (an intentional output change)", () => {
  it("names a visible replacement, and withholds a hidden one's title", async () => {
    const { orgId } = createOrganization("MCP Superseded Org");
    const a = registerAgent(orgId, "Ada");
    const c = registerAgent(orgId, "Cy");
    for (const key of ["github.com/acme/alpha", "github.com/acme/beta"]) {
      db.prepare(`INSERT INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, 1)`).run(orgId, key, key.split("/").pop());
    }
    db.prepare(`UPDATE agents SET scope = 'project', home_project = 'github.com/acme/alpha' WHERE id = ?`).run(c.agentId);
    db.prepare(`UPDATE organizations SET project_isolation = 1 WHERE id = ?`).run(orgId);
    invalidateScopes();
    const visible = put(orgId, a, { title: "Alpha v2", project_key: "github.com/acme/alpha", created_at: "2026-09-01 10:00:01" });
    const hidden = put(orgId, a, { title: "Beta secret v2", project_key: "github.com/acme/beta", created_at: "2026-09-01 10:00:02" });
    put(orgId, a, { title: "Alpha v1", project_key: "github.com/acme/alpha", superseded_by: visible, created_at: "2026-09-01 10:00:03" });
    put(orgId, a, { title: "Alpha other v1", project_key: "github.com/acme/alpha", superseded_by: hidden, created_at: "2026-09-01 10:00:04" });
    const live = put(orgId, a, { title: "Alpha live", project_key: "github.com/acme/alpha", created_at: "2026-09-01 10:00:05" });
    const client = await connect(c.apiKey);
    const lines = text(await client.callTool({ name: "list_tasks", arguments: {} })).split("\n");
    const line = (title: string) => lines.find((l) => l.includes(`] ${title} (id`))!;
    expect(line("Alpha v1")).toContain(` | superseded by "Alpha v2" (id ${visible})`);
    expect(line("Alpha other v1")).toContain(" | superseded by a newer task (title withheld)");
    expect(line("Alpha other v1")).not.toContain(hidden);
    expect(lines.join("\n")).not.toContain("Beta secret v2");
    expect(line("Alpha live")).not.toContain("superseded");
    expect(line("Alpha live")).toContain(`(id ${live})`);
    // get_task carries the same marker.
    const one = text(await client.callTool({ name: "get_task", arguments: { taskId: lines.find((l) => l.includes("Alpha v1"))!.match(/\(id ([^)]+)\)/)![1] } }));
    expect(one).toContain(` | superseded by "Alpha v2" (id ${visible})`);
    await client.close();
  });
});
