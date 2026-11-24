import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { archiveMemory, createMemory, getMemory, listMemory, searchMemory, supersedeMemory } from "../src/memory.js";

function setupOrg(name = "Memory Org") {
  const { orgId } = createOrganization(name);
  const a = registerAgent(orgId, "Agent A");
  const b = registerAgent(orgId, "Agent B");
  return {
    orgId,
    a: { id: a.agentId, name: "Agent A", key: a.apiKey },
    b: { id: b.agentId, name: "Agent B", key: b.apiKey },
  };
}

describe("createMemory / listMemory", () => {
  it("creates an active entry visible in the default (active-only) list", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "Retro DB choice", body: "We picked SQLite over Postgres for v1 because ops simplicity mattered more than concurrent writers." });
    expect(entry.status).toBe("active");
    expect(entry.superseded_by).toBeNull();
    expect(listMemory(orgId).entries.map((e) => e.id)).toContain(entry.id);
  });

  it("rejects an empty title or body", () => {
    const { orgId, a } = setupOrg();
    expect(() => createMemory(orgId, a, { title: "  ", body: "x" })).toThrow(/title/);
    expect(() => createMemory(orgId, a, { title: "x", body: "  " })).toThrow(/body/);
  });

  it("lists most-recent-first and paginates with a cursor", () => {
    const { orgId, a } = setupOrg();
    const ids = ["one", "two", "three"].map((t) => createMemory(orgId, a, { title: t, body: t }).id);
    const page1 = listMemory(orgId, { limit: 2 });
    expect(page1.entries.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = listMemory(orgId, { limit: 2, before: page1.nextCursor });
    expect(page2.entries.map((e) => e.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("filters by tag", () => {
    const { orgId, a } = setupOrg();
    const tagged = createMemory(orgId, a, { title: "tagged", body: "b", tag: "backend" });
    createMemory(orgId, a, { title: "untagged", body: "b" });
    expect(listMemory(orgId, { tag: "backend" }).entries.map((e) => e.id)).toEqual([tagged.id]);
  });
});

describe("searchMemory", () => {
  it("finds a case-insensitive substring in the title or body", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "Caching heuristic", body: "BuildCache needs SAMPLE_BUILDCACHE_IN_TRIAGE=1 to run for real." });
    createMemory(orgId, a, { title: "unrelated", body: "nothing to do with builds" });
    expect(searchMemory(orgId, "BUILDCACHE").entries.map((e) => e.id)).toEqual([entry.id]);
    expect(searchMemory(orgId, "caching heuristic").entries.map((e) => e.id)).toEqual([entry.id]);
    expect(searchMemory(orgId, "no such term anywhere").entries).toEqual([]);
  });

  it("treats literal % and _ in the query as literal characters, not LIKE wildcards", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "coverage note", body: "hit rate was 42% on the smoke suite" });
    createMemory(orgId, a, { title: "decoy", body: "hit rate was 4X% on a different suite" });
    expect(searchMemory(orgId, "42%").entries.map((e) => e.id)).toEqual([entry.id]);
  });

  it("excludes archived entries by default and includes them with includeArchived", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "old approach", body: "we tried caching here and it caused test pollution" });
    archiveMemory(orgId, a, entry.id, "superseded by opt-in cache");
    expect(searchMemory(orgId, "caching").entries).toEqual([]);
    expect(searchMemory(orgId, "caching", { includeArchived: true }).entries.map((e) => e.id)).toEqual([entry.id]);
  });
});

describe("archiveMemory / supersedeMemory", () => {
  it("archiving hides an entry from the default list but keeps it retrievable by id", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "stale note", body: "we tried X, it didn't work" });
    expect(listMemory(orgId).entries.map((e) => e.id)).toContain(entry.id);

    const result = archiveMemory(orgId, a, entry.id, "resolved by the retry fix");
    expect(result.ok).toBe(true);

    expect(listMemory(orgId).entries.map((e) => e.id)).not.toContain(entry.id);
    expect(listMemory(orgId, { includeArchived: true }).entries.map((e) => e.id)).toContain(entry.id);

    const byId = getMemory(orgId, entry.id);
    expect(byId?.status).toBe("archived");
    expect(byId?.archived_reason).toBe("resolved by the retry fix");
  });

  it("refuses to archive an already-archived entry or an unknown id", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "t", body: "b" });
    expect(archiveMemory(orgId, a, entry.id).ok).toBe(true);
    expect(archiveMemory(orgId, a, entry.id).ok).toBe(false);
    expect(archiveMemory(orgId, a, "nope").ok).toBe(false);
  });

  it("supersede creates a new entry, archives the old one, and links them both ways", () => {
    const { orgId, a } = setupOrg();
    const original = createMemory(orgId, a, { title: "old cache design", body: "global cache, no org key" });

    const result = supersedeMemory(orgId, a, original.id, { title: "new cache design", body: "org-scoped cache key, fixes the leak" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fresh = result.entry;
    expect(fresh.title).toBe("new cache design");
    expect(fresh.status).toBe("active");

    const old = getMemory(orgId, original.id)!;
    expect(old.status).toBe("archived");
    expect(old.superseded_by).toBe(fresh.id);

    // The stale entry is out of the default view; the fresh one is in it.
    const active = listMemory(orgId).entries.map((e) => e.id);
    expect(active).toContain(fresh.id);
    expect(active).not.toContain(original.id);
  });

  it("refuses to supersede an already-archived entry", () => {
    const { orgId, a } = setupOrg();
    const entry = createMemory(orgId, a, { title: "t", body: "b" });
    archiveMemory(orgId, a, entry.id);
    const result = supersedeMemory(orgId, a, entry.id, { title: "t2", body: "b2" });
    expect(result.ok).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("never lists, searches, or fetches another org's memory entries -- even with colliding titles", () => {
    const one = setupOrg("Org One");
    const two = setupOrg("Org Two");
    const entryOne = createMemory(one.orgId, one.a, { title: "shared secret plan", body: "identical collision-test body" });
    const entryTwo = createMemory(two.orgId, two.a, { title: "shared secret plan", body: "identical collision-test body" });

    expect(listMemory(one.orgId).entries.map((e) => e.id)).toContain(entryOne.id);
    expect(listMemory(one.orgId).entries.map((e) => e.id)).not.toContain(entryTwo.id);
    expect(listMemory(two.orgId).entries.map((e) => e.id)).not.toContain(entryOne.id);

    expect(searchMemory(one.orgId, "collision-test").entries.map((e) => e.id)).toEqual([entryOne.id]);
    expect(searchMemory(two.orgId, "collision-test").entries.map((e) => e.id)).toEqual([entryTwo.id]);

    // Fetching org two's id while scoped to org one must behave as "doesn't exist", not leak it.
    expect(getMemory(one.orgId, entryTwo.id)).toBeNull();
    expect(getMemory(two.orgId, entryOne.id)).toBeNull();

    // Same for mutation: org one can't archive an entry that belongs to org two.
    expect(archiveMemory(one.orgId, one.a, entryTwo.id).ok).toBe(false);
  });
});

describe("REST /v1/memory", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("create -> list -> search -> get -> archive round-trip", async () => {
    const { a } = setupOrg("REST Memory Org");

    const created = await call(a.key, "POST", "/v1/memory", { title: "Wire dashboard gotcha", body: "The dashboard route needs the org header or it 403s.", tag: "frontend" });
    expect(created.status).toBe(201);
    const { entry } = (await created.json()) as { entry: { id: string } };

    const listed = (await (await call(a.key, "GET", "/v1/memory")).json()) as { entries: Array<{ id: string }> };
    expect(listed.entries.map((e) => e.id)).toContain(entry.id);

    const searched = (await (await call(a.key, "GET", "/v1/memory/search?q=org%20header")).json()) as { entries: Array<{ id: string }> };
    expect(searched.entries.map((e) => e.id)).toContain(entry.id);

    const got = (await (await call(a.key, "GET", `/v1/memory/${entry.id}`)).json()) as { entry: { id: string } };
    expect(got.entry.id).toBe(entry.id);

    const archived = await call(a.key, "POST", `/v1/memory/${entry.id}/archive`, { reason: "fixed upstream" });
    expect(archived.status).toBe(200);

    const listedAfter = (await (await call(a.key, "GET", "/v1/memory")).json()) as { entries: Array<{ id: string }> };
    expect(listedAfter.entries.map((e) => e.id)).not.toContain(entry.id);

    const conflict = await call(a.key, "POST", `/v1/memory/${entry.id}/archive`, {});
    expect(conflict.status).toBe(409);
  });

  it("requires a title and a body", async () => {
    const { a } = setupOrg("REST Memory Org 2");
    expect((await call(a.key, "POST", "/v1/memory", { body: "no title" })).status).toBe(400);
    expect((await call(a.key, "POST", "/v1/memory", { title: "no body" })).status).toBe(400);
  });

  it("404s an archive/supersede on an id from another org", async () => {
    const one = setupOrg("REST Memory Org 3");
    const two = setupOrg("REST Memory Org 4");
    const created = await call(one.a.key, "POST", "/v1/memory", { title: "t", body: "b" });
    const { entry } = (await created.json()) as { entry: { id: string } };
    const crossOrgArchive = await call(two.a.key, "POST", `/v1/memory/${entry.id}/archive`, {});
    expect(crossOrgArchive.status).toBe(404);
    const crossOrgGet = await call(two.a.key, "GET", `/v1/memory/${entry.id}`);
    expect(crossOrgGet.status).toBe(404);
  });
});
