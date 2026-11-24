import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { invalidateScopes } from "../src/scope.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { claimTask, completeTask, createTask, getTaskById, listTasks, releaseTask, renewClaim, supersedeTask } from "../src/tasks.js";

/**
 * SUPERSESSION: a correction is its own task, LINKED to the row it corrects.
 *
 * Measured at origin/main: ~26 of ~80 open board rows are CORRECTION / DELTA / CLOSURE records filed
 * against other rows, each naming the same cause in its own body ("there is no `update_task` in
 * src/tasks.ts"). The absence is correct — editing a filed task rewrites the record of what someone
 * actually filed — and the defect is that nothing LINKED them, so a reader reconciling a chain by
 * scanning titles could silently miss one (859bd42f needs 0421c06a AND 2d7df1df; 3f75ad96 carries
 * three corrections each amending the last).
 *
 * This mirrors `supersedeMemory` / `memory_entries.superseded_by`. Its refusal rule is the part that
 * matters and it is carried over verbatim in spirit: re-superseding a superseded row would silently
 * rewrite history, so it fails LOUDLY instead of chaining.
 *
 * EVERY ASSERTION NAMES ITS FALSIFIER. Each `it` below states, in its own comment, the mutation that
 * makes it red — and the mutations were run, not imagined.
 */

function setupOrg(name = "Supersession Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Author A");
  const b = registerAgent(orgId, "Author B");
  return {
    orgId,
    a: { id: a.agentId, name: "Author A" },
    b: { id: b.agentId, name: "Author B" },
  };
}

describe("supersedeTask", () => {
  it("files the correction as its OWN row and links the old one to it", () => {
    // FALSIFIER: dropping the UPDATE in supersedeTask's transaction. The new row still exists (the
    // create is separate), so THIS test is the one that catches it — the row count alone would not.
    const { orgId, a } = setupOrg("Supersede Files");
    const original = createTask(orgId, a, { title: "The original claim" });
    const correction = supersedeTask(orgId, a, original.id, { title: "The corrected claim" });

    expect(correction.id, "the correction is a new task, not an edit").not.toBe(original.id);
    expect(listTasks(orgId)).toHaveLength(2);
    expect(getTaskById(orgId, a, original.id)!.superseded_by).toBe(correction.id);
    expect(getTaskById(orgId, a, correction.id)!.superseded_by, "the correction is itself live").toBeNull();
  });

  it("LEAVES THE CORRECTED ROW READABLE and keeps its status", () => {
    // FALSIFIER: making supersedeTask close or delete the old row. The design is that a correction
    // does not RESOLVE anything — an open row whose subject was mis-stated is still open work, just
    // described differently — so a mutation that sets status would redden this.
    const { orgId, a } = setupOrg("Supersede Readable");
    const original = createTask(orgId, a, { title: "Still open, wrongly described", requiredReviews: 2 });
    const correction = supersedeTask(orgId, a, original.id, { title: "Correctly described" });

    const after = getTaskById(orgId, a, original.id)!;
    expect(after.status, "status is untouched by supersession").toBe("open");
    expect(after.title, "and its original text is intact").toBe("Still open, wrongly described");
    expect(after.required_reviews, "nor is any other field amended").toBe(2);
    expect(correction.required_reviews, "the correction carries its own fields").toBe(1);
  });

  it("THE LOAD-BEARING FIELD: the default listing reports the supersession, and names the replacement", () => {
    // FALSIFIER: deleting the `superseded` / `superseded_by_title` computation in view(). A link that
    // nothing displays is decoration — the same defect class as a state that can never be produced —
    // so the assertion is on the LISTING and the single-row READ, not on the column.
    const { orgId, a } = setupOrg("Supersede Listing");
    const original = createTask(orgId, a, { title: "Old" });
    const correction = supersedeTask(orgId, a, original.id, { title: "New" });

    // TWO READERS, TWO OBLIGATIONS, and the first draft of this test conflated them. `superseded` is
    // a fact about the row the viewer is ALREADY reading, so it is always reported; the replacement's
    // TITLE needs a viewer to check visibility against, so a viewer-less listing withholds it.
    const anon = listTasks(orgId).find((t) => t.id === original.id)!;
    expect(anon.superseded, "a board view sees it is superseded without parsing the id").toBe(true);
    expect(anon.superseded_by_title, "a viewer-less listing withholds the title rather than leaking it").toBeNull();

    const listed = listTasks(orgId, { viewer: a.id }).find((t) => t.id === original.id)!;
    expect(listed.superseded, "the same flag, with a viewer").toBe(true);
    expect(listed.superseded_by_title, "and is told what replaced it, without a second fetch").toBe("New");

    const read = getTaskById(orgId, a, original.id)!;
    expect(read.superseded).toBe(true);
    expect(read.superseded_by_title).toBe("New");

    // ...and the LIVE row must NOT read as superseded, or the flag is merely always-on.
    const live = listTasks(orgId).find((t) => t.id === correction.id)!;
    expect(live.superseded, "the replacement is not itself superseded").toBe(false);
    expect(live.superseded_by_title).toBeNull();
  });

  it("REFUSES an already-superseded target, loudly — never a silent chain", () => {
    // THE MANDATORY REFUSAL, carried over from supersedeMemory: "re-superseding a superseded note
    // would silently rewrite history". Two consecutive corrections would make a reader follow two
    // hops, and each further one adds another.
    // FALSIFIER: deleting the `if (current.superseded_by) throw` guard — this throws, and without it
    // the call would succeed and the first correction would be silently re-pointed.
    const { orgId, a } = setupOrg("Supersede Refusal");
    const original = createTask(orgId, a, { title: "Original" });
    const first = supersedeTask(orgId, a, original.id, { title: "First correction" });

    expect(() => supersedeTask(orgId, a, original.id, { title: "Second correction" }))
      .toThrow(/already superseded by/);
    // ...and the refusal is LOUD AND INERT: the failed call created nothing.
    expect(listTasks(orgId)).toHaveLength(2);
    expect(getTaskById(orgId, a, original.id)!.superseded_by, "the link is unchanged by the refusal").toBe(first.id);

    // Superseding the CURRENT row is the supported path, so the guard is not simply blocking everything.
    const second = supersedeTask(orgId, a, first.id, { title: "Second correction" });
    expect(getTaskById(orgId, a, first.id)!.superseded_by).toBe(second.id);
    expect(listTasks(orgId)).toHaveLength(3);
  });

  it("refuses an unknown target rather than creating an unlinked row", () => {
    // FALSIFIER: moving the `getTask` existence check after `createTask`. The correction would then
    // exist as an orphan while the caller saw an error — a row filed for a link that is not there.
    const { orgId, a } = setupOrg("Supersede Unknown");
    const before = listTasks(orgId).length;
    expect(() => supersedeTask(orgId, a, "no-such-task-id", { title: "Orphan" })).toThrow(/No task found/);
    expect(listTasks(orgId), "nothing was created for an unknown target").toHaveLength(before);
  });

  it("records the supersession as an EVENT, so the timeline explains the row", () => {
    // FALSIFIER: dropping the emitEvent. Nothing else in the suite reads it, so without this the
    // timeline would go silent on a board change that a reader may need to reconstruct.
    const { orgId, a } = setupOrg("Supersede Event");
    const original = createTask(orgId, a, { title: "Before" });
    const correction = supersedeTask(orgId, a, original.id, { title: "After" });

    const ev = db.prepare(`SELECT type, subject_id, payload FROM events WHERE org_id = ? AND type = 'task.superseded'`).get(orgId) as
      | { type: string; subject_id: string; payload: string }
      | undefined;
    expect(ev, "task.superseded must be emitted").toBeTruthy();
    expect(ev!.subject_id, "it is about the SUPERSEDED row, which is the one a reader holds").toBe(original.id);
    expect(JSON.parse(ev!.payload).supersededBy).toBe(correction.id);
  });

  it("does not leak the replacement's title to a viewer who cannot see it", () => {
    // The flag is a fact about the row the viewer is already reading; the replacement's SUBJECT is
    // not. A correction filed in a project this viewer cannot see must withhold its title.
    // FALSIFIER: removing the `hiddenFrom` guard in view() — the title would appear here.
    const { orgId, a } = setupOrg("Supersede Visibility");
    const original = createTask(orgId, a, { title: "Public row" });
    const correction = supersedeTask(orgId, a, original.id, { title: "Title in a hidden project" });
    // Simulate the replacement being invisible to this viewer by pointing the link at a row in another
    // org — the guard is on visibility, so an id the viewer cannot resolve must read as withheld.
    db.prepare(`UPDATE tasks SET superseded_by = ? WHERE id = ?`).run("foreign-org-task", original.id);

    const seen = getTaskById(orgId, a, original.id)!;
    expect(seen.superseded, "the fact about THIS row is still reported").toBe(true);
    expect(seen.superseded_by_title, "but an unresolvable replacement withholds its title").toBeNull();

    // ...and the control: with a resolvable replacement the title DOES appear, so the assertion above
    // is not passing because the feature never populates it.
    db.prepare(`UPDATE tasks SET superseded_by = ? WHERE id = ?`).run(correction.id, original.id);
    expect(getTaskById(orgId, a, original.id)!.superseded_by_title).toBe("Title in a hidden project");
  });
});

/**
 * THE SURFACES — because a function only tests can reach is the same defect as a link nothing
 * displays, one layer up: the capability exists and no agent can use it.
 *
 * Driven through a REAL MCP client over HTTP (src/mcp.ts), not by calling the module, so this
 * proves the tool is registered, listed and reachable rather than merely implemented.
 * FALSIFIER: removing the `server.registerTool("supersede_task", ...)` block, or dropping it from
 * IDEMPOTENT_TOOLS — either reddens this.
 */
describe("supersede_task over MCP", () => {
  it("is a listed tool, files the correction, and surfaces the refusal as an error", async () => {
    const http = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { handleMcpRequest } = await import("../src/mcp.js");
    const { createTask, listTasks } = await import("../src/tasks.js");

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        void handleMcpRequest(req as never, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    const { orgId } = createOrganization("Supersession MCP Org");
    const agent = registerAgent(orgId, "MCP Author");
    const client = new Client({ name: "supersede-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${agent.apiKey}` } } }));
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");
    try {
      // THE TOOL IS REACHABLE: it appears in the listing a client discovers.
      const names = ((await client.listTools()).tools ?? []).map((t) => t.name);
      expect(names, "supersede_task must be discoverable, not merely implemented").toContain("supersede_task");

      const original = createTask(orgId, { id: agent.agentId, name: "MCP Author" }, { title: "Filed row" });
      const out = text(await client.callTool({ name: "supersede_task", arguments: { taskId: original.id, title: "The correction" } }));
      expect(out).toContain("Superseded");
      expect(listTasks(orgId).find((t) => t.id === original.id)!.superseded, "the link is visible to the board").toBe(true);

      // THE REFUSAL SURFACES AS A MESSAGE, not a crash: the tool returns the guard's text.
      const again = text(await client.callTool({ name: "supersede_task", arguments: { taskId: original.id, title: "Correction of a correction" } }));
      expect(again, "the refusal must reach the caller in words").toMatch(/already superseded by/);
    } finally {
      await client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

/**
 * THE REST SURFACE. Added because the MCP tool test alone left a real gap: `rest-mcp-parity.test.ts`
 * SPOT-CHECKS specific tools rather than enumerating, so it does not cover a new one automatically —
 * meaning the route I added would have shipped with no test at all, and an untested route is a
 * second, quieter version of "a link nothing displays".
 *
 * FALSIFIER: removing the `app.post("/v1/tasks/:taskId/supersede", ...)` route — this reddens with a
 * 404. Removing only the try/catch turns the refusal into a 500 rather than a named 400.
 */
describe("supersede_task over REST", () => {
  it("files the correction, reports the link, and refuses a second one with 400", async () => {
    const http = await import("node:http");
    const { app } = await import("../src/rest.js");
    const { createTask } = await import("../src/tasks.js");
    const server = http.createServer((req, res) => app(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { orgId } = createOrganization("Supersession REST Org");
    const agent = registerAgent(orgId, "REST Author");
    const call = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const original = createTask(orgId, { id: agent.agentId, name: "REST Author" }, { title: "Filed over the board" });
      const filed = await call(`/v1/tasks/${original.id}/supersede`, { title: "Corrected over REST" });
      expect(filed.status, "201 Created, like create_task").toBe(201);
      const created = (await filed.json()) as { task: { id: string; superseded: boolean } };
      expect(created.task.superseded, "the CORRECTION is the live row").toBe(false);

      // The corrected row reports the link through the listing, which is the load-bearing requirement.
      const listed = (await (await fetch(`${base}/v1/tasks`, { headers: { authorization: `Bearer ${agent.apiKey}` } })).json()) as {
        tasks: Array<{ id: string; superseded: boolean; superseded_by_title: string | null }>;
      };
      const old = listed.tasks.find((t) => t.id === original.id)!;
      expect(old.superseded).toBe(true);
      expect(old.superseded_by_title).toBe("Corrected over REST");

      // The refusal is a NAMED 400, not a 500 and not a silent success.
      const again = await call(`/v1/tasks/${original.id}/supersede`, { title: "Too late" });
      expect(again.status, "the refusal is a 400, not a 500").toBe(400);
      expect(((await again.json()) as { error: string }).error).toMatch(/already superseded by/);

      // And a missing title is rejected before anything is filed.
      const untitled = await call(`/v1/tasks/${created.task.id}/supersede`, {});
      expect(untitled.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("the supersession event cannot claim a supersession that did not happen", () => {
  /**
   * THE RACE, bounded by e617 and ruled blocking by 9d1f. The guard `AND superseded_by IS NULL` can
   * decline to write if another writer supersedes the row between the pre-check and the UPDATE — and
   * the correction row is created OUTSIDE the transaction, which is what opens the window. First
   * verdict said this honestly: not easily reachable. What mattered was that when it fires,
   * `task.superseded` is emitted for a row that was NOT superseded — and this PR exists to make
   * corrections traceable, so a lying audit entry is the wrong defect to ship here.
   *
   * WHY THE TEST IS VACUOUS-VULNERABLE: the pre-check inside the function throws on an
   * already-superseded target, and supersedeTask creates the correction OUTSIDE the transaction — so
   * nothing downstream can tell the UPDATE declined except that UPDATE's own `.changes`. That is the
   * failure this test pins: it drives the write directly with the guard's decline FORCED, and asserts
   * that the event does NOT fire and that the caller LEARNS the supersession did not take.
   *
   * **UNFIRED.** This assertion cannot be falsified by a single-threaded test: the pre-check throws on
   * an already-superseded target before the transaction, so the only composition that forces the UPDATE
   * to decline is a *concurrent* supersession between check and write — which is exactly the race the
   * guard exists for and which this suite cannot stage. **The guard is kept and labelled rather than
   * deleted, because deleting it would hide the gap.**
   *
   * **WHAT WOULD FIRE IT** (named so the next person does not re-derive the dead ends): two connections
   * interleaving across the check/write boundary, or an injected seam at the transaction. Not required,
   * not now — naming it converts "we could not" into "here is what it would take", which is the
   * difference between a limitation and an excuse.
   */
  it("declined write: no event fires and the caller learns the supersession did not take", () => {
    const { orgId, a } = setupOrg("Supersede Race");
    const original = createTask(orgId, a, { title: "Original" });

    // FORCE the decline: pre-supersede the row so the guard `superseded_by IS NULL` never matches,
    // exactly what a racing writer between pre-check and UPDATE would leave behind.
    db.prepare(`UPDATE tasks SET superseded_by = 'race-winner-task' WHERE id = ?`).run(original.id);

    const eventsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'task.superseded'`).get() as { n: number }).n;
    // The caller must LEARN the supersession did not take — a silent pass would orphan the correction.
    expect(() => supersedeTask(orgId, a, original.id, { title: "The correction" })).toThrow(/already superseded|superseded by another writer/);

    const eventsAfter = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'task.superseded'`).get() as { n: number }).n;
    expect(eventsAfter, "a declined write must NOT emit task.superseded — the event is the audit trail, and it cannot claim a supersession that did not happen").toBe(eventsBefore);

    // ...and nothing else was disturbed by the failed call.
    expect((db.prepare(`SELECT superseded_by FROM tasks WHERE id = ?`).get(original.id) as { superseded_by: string }).superseded_by,
      "the racing winner's link is intact").toBe("race-winner-task");
  });
});

/**
 * A SUPERSEDED ROW TAKES NO NEW CLAIMS (Q1.5 596b0155, under supersession 3642e9e9). Supersession itself stays descriptive
 * (the row keeps its status and text, above); what changes is that nobody can START work on it any more, because its work
 * moved to the correction. The current holder is not evicted: a claim won before the supersession keeps renewing until a
 * coordinated handoff. No reassignment, no forced release, no other lifecycle change.
 *
 * TWO LAYERS, ONE RULE: claimTask refuses up front, and the UPDATE's own predicate refuses too, so a supersession landing
 * between the check and the write still blocks the claim. Most tests below are stopped by the up-front check; the
 * interposition test writes the supersession after that check and immediately before the claim's UPDATE, so it is the one
 * that reddens when only the SQL predicate is removed.
 *
 * EVERY ASSERTION NAMES ITS FALSIFIER.
 */
describe("claiming a superseded task", () => {
  const claimedEvents = (orgId: string, taskId: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'task.claimed' AND subject_id = ?`).get(orgId, taskId) as { n: number }).n;
  const expireLease = (taskId: string) =>
    db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), taskId);

  it("refuses a new claim on an open superseded row, changes nothing, and emits no task.claimed", () => {
    // FALSIFIER: removing BOTH the up-front refusal and the UPDATE's `superseded_by` clause; the claim would then land.
    const { orgId, a, b } = setupOrg("Claim Superseded Open");
    const original = createTask(orgId, a, { title: "Old framing" });
    const correction = supersedeTask(orgId, a, original.id, { title: "New framing" });

    const refused = claimTask(orgId, b, original.id);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/superseded/);
    expect(!refused.ok && refused.error, "the caller can see the correction, so it is named").toContain(correction.id);
    const row = getTaskById(orgId, b, original.id)!;
    expect(row.status, "the refused row is untouched").toBe("open");
    expect(row.claimed_by_agent_id).toBeNull();
    expect(claimedEvents(orgId, original.id), "a refusal is not a claim").toBe(0);

    // CONTROL: the correction itself is claimable, so the refusal is about supersession, not about claiming at all.
    expect(claimTask(orgId, b, correction.id).ok).toBe(true);
  });

  it("refuses to let another agent take over an EXPIRED lease on a superseded row", () => {
    // FALSIFIER: the guard limited to open rows; the expired-lease takeover branch would admit B.
    const { orgId, a, b } = setupOrg("Claim Superseded Takeover");
    const original = createTask(orgId, a, { title: "Held, then superseded" });
    expect(claimTask(orgId, a, original.id).ok).toBe(true);
    supersedeTask(orgId, a, original.id, { title: "The correction" });
    expireLease(original.id);
    const events = claimedEvents(orgId, original.id);

    const refused = claimTask(orgId, b, original.id);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/superseded/);
    expect(getTaskById(orgId, a, original.id)!.claimed_by_agent_id, "the holder is not displaced").toBe(a.id);
    expect(claimedEvents(orgId, original.id), "no takeover event").toBe(events);
  });

  it("keeps the holder's claim when the supersession lands after it: renewal, renew_claim and completion still work", () => {
    // FALSIFIER: the predicate written as `superseded_by IS NULL` alone (no holder exception); the holder's re-claim fails.
    const { orgId, a } = setupOrg("Claim Before Supersede");
    const original = createTask(orgId, a, { title: "Claimed first" });
    expect(claimTask(orgId, a, original.id).ok).toBe(true);
    supersedeTask(orgId, a, original.id, { title: "Corrected later" });
    const events = claimedEvents(orgId, original.id);

    expect(claimTask(orgId, a, original.id).ok, "a same-holder re-claim is a renewal").toBe(true);
    expireLease(original.id);
    expect(claimTask(orgId, a, original.id).ok, "the intentional expired-owner renewal still holds").toBe(true);
    expect(renewClaim(orgId, a, original.id).ok, "renew_claim is unchanged").toBe(true);
    expect(claimedEvents(orgId, original.id), "renewals emit no new task.claimed").toBe(events);
    expect(completeTask(orgId, a, original.id, "finished the work I held").ok, "the holder can still finish").toBe(true);
  });

  it("the UPDATE's own predicate refuses a supersession that lands after the up-front check", () => {
    // A racing writer, interposed: a test-only wrapper on the statement prototype (as tests/task-paging.test.ts's
    // countStatements does) links the row to its correction immediately before the claim's UPDATE runs, inside the claim's
    // own transaction and after claimTask's up-front check has passed. No production seam; the wrapper is restored in finally.
    // FALSIFIER: removing ONLY the UPDATE's `superseded_by` clause; the claim would then land on the superseded row.
    const { orgId, a, b } = setupOrg("Claim Interposed");
    const original = createTask(orgId, a, { title: "Raced" });
    const correction = createTask(orgId, a, { title: "Racing correction" });
    const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
    const run = proto.run;
    let interposed = 0;
    proto.run = function (this: { source: string }, ...args: unknown[]) {
      if (interposed === 0 && this.source.includes("SET status = 'claimed'")) {
        interposed++;
        run.call(db.prepare(`UPDATE tasks SET superseded_by = ? WHERE id = ?`), correction.id, original.id);
      }
      return run.apply(this, args);
    };
    let refused!: ReturnType<typeof claimTask>;
    try {
      refused = claimTask(orgId, b, original.id);
    } finally {
      proto.run = run;
    }
    expect(interposed, "the racing write landed between the check and the UPDATE").toBe(1);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error, "reported as a supersession, not a generic failure").toMatch(/superseded/);
    expect(!refused.ok && refused.error).toContain(correction.id);
    const row = getTaskById(orgId, a, original.id)!;
    expect(row.status, "no mutation").toBe("open");
    expect(row.claimed_by_agent_id).toBeNull();
    expect(claimedEvents(orgId, original.id), "no task.claimed").toBe(0);
  });

  it("a holder who RELEASES a superseded row cannot re-acquire it", () => {
    // FALSIFIER: the holder exception keyed on the owner field without `status = 'claimed'`, or a release that kept it.
    const { orgId, a } = setupOrg("Release Then Reclaim");
    const original = createTask(orgId, a, { title: "Let go" });
    expect(claimTask(orgId, a, original.id).ok).toBe(true);
    supersedeTask(orgId, a, original.id, { title: "Replacement" });
    expect(releaseTask(orgId, a, original.id).ok).toBe(true);

    const refused = claimTask(orgId, a, original.id);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/superseded/);
    expect(getTaskById(orgId, a, original.id)!.status).toBe("open");
  });

  it("does not reveal a REAL replacement outside the caller's projects, by id or by title; a caller who can see it is told", () => {
    // A real, existing replacement that project isolation hides from the caller (not a dangling id, which would only prove
    // the missing-target fallback). The same rows, read by a workspace-scope agent, are the visible control.
    // FALSIFIER: dropping the hiddenFrom check in supersededRefusal; B's error would then name "Beta-only correction".
    const ALPHA = "github.com/acme/alpha";
    const BETA = "github.com/acme/beta";
    const { orgId, a, b } = setupOrg("Claim Hidden Replacement");
    for (const key of [ALPHA, BETA]) {
      db.prepare(`INSERT OR IGNORE INTO projects (org_id, project_key, name, enabled) VALUES (?, ?, ?, 1)`).run(orgId, key, key.split("/").pop());
    }
    const original = createTask(orgId, a, { title: "Alpha row", project: ALPHA });
    const correction = supersedeTask(orgId, a, original.id, { title: "Beta-only correction", project: BETA });
    const w = { id: registerAgent(orgId, "Workspace Watcher").agentId, name: "Workspace Watcher" };
    // Project isolation on, with B a project-scope agent at home in alpha (the tests/task-paging.test.ts isolate() fixture).
    db.prepare(`UPDATE agents SET scope = 'project', home_project = ? WHERE id = ?`).run(ALPHA, b.id);
    db.prepare(`UPDATE organizations SET project_isolation = 1 WHERE id = ?`).run(orgId);
    invalidateScopes();

    // The premise: B sees the superseded row (and that it is superseded) but not the replacement.
    const seen = getTaskById(orgId, b, original.id)!;
    expect(seen.superseded, "B can read the superseded row").toBe(true);
    expect(seen.superseded_by_title, "and the read path already withholds the replacement").toBeNull();
    expect(getTaskById(orgId, b, correction.id), "the replacement is outside B's projects").toBeFalsy();

    const refused = claimTask(orgId, b, original.id);
    expect(refused.ok).toBe(false);
    const error = !refused.ok ? refused.error : "";
    expect(error).toMatch(/superseded by a newer task/);
    expect(error).not.toContain(correction.id);
    expect(error).not.toContain("Beta-only correction");
    expect(getTaskById(orgId, a, original.id)!.claimed_by_agent_id).toBeNull();

    // CONTROL: a workspace-scope caller sees the replacement, so the same refusal names it.
    const told = claimTask(orgId, w, original.id);
    expect(told.ok).toBe(false);
    expect(!told.ok && told.error).toContain(correction.id);
    expect(!told.ok && told.error).toContain("Beta-only correction");
  });

  it("leaves every other claim rule as it was: live rows, an active other holder, and done rows", () => {
    // CONTROLS (green before and after): the guard is scoped to superseded rows that are not done.
    const { orgId, a, b } = setupOrg("Claim Controls");
    const live = createTask(orgId, a, { title: "Never superseded" });
    expect(claimTask(orgId, a, live.id).ok, "a live row is claimable").toBe(true);
    const held = claimTask(orgId, b, live.id);
    expect(held.ok).toBe(false);
    expect(!held.ok && held.error, "the active-holder message is unchanged").toMatch(/is claimed by Author A until/);

    const done = createTask(orgId, a, { title: "Finished then superseded" });
    expect(claimTask(orgId, a, done.id).ok).toBe(true);
    expect(completeTask(orgId, a, done.id, "done").ok).toBe(true);
    supersedeTask(orgId, a, done.id, { title: "Later correction" });
    const again = claimTask(orgId, b, done.id);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error, "a done row still reports done, not superseded").toMatch(/already done/);
  });
});
