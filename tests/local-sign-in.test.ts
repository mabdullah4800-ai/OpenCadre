// Local sign-in (src/local-sign-in.ts): the hub admin mints a one-time link, and opening it signs a person in on a
// hub that has no sign-in provider. Each refusal below has an accepting control beside it, so a test cannot pass
// because nothing works.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHub } from "./helpers/device-hub.js";
import {
  consumeLocalTicket, issueLocalTicket, LOCAL_TICKET_TTL_MS, localPersonId, MAX_OUTSTANDING_TICKETS,
  normalizeLocalEmail, outstandingLocalTickets, resetLocalTickets,
} from "../src/local-sign-in.js";

const ADMIN = "test-admin-token-for-local-sign-in";
const ENV_KEYS = ["OPENCADRE_ADMIN_TOKEN", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "OPENCADRE_PUBLIC_APP_URL", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

let hub: Awaited<ReturnType<typeof startHub>>;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.close(); });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OPENCADRE_ADMIN_TOKEN = ADMIN;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.OPENCADRE_PUBLIC_APP_URL;
  resetLocalTickets();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLocalTickets();
});

const mint = (body: unknown, token: string | null = ADMIN) =>
  fetch(`${hub.url}/v1/admin/sign-in-links`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

const open = (url: string) => fetch(url, { redirect: "manual" });
const sessionCookieOf = (res: Response) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("oc_session=")) ?? null;
const me = (cookie: string) => fetch(`${hub.url}/v1/auth/me`, { headers: { cookie: cookie.split(";")[0] } });

describe("the ticket store", () => {
  it("normalizes the address and derives one stable local person id from it", () => {
    expect(normalizeLocalEmail("  Ada@Example.TEST ")).toBe("ada@example.test");
    expect(normalizeLocalEmail("not-an-address")).toBeNull();
    expect(normalizeLocalEmail(42)).toBeNull();
    expect(localPersonId("ada@example.test")).toMatch(/^local-[0-9a-f]{32}$/);
    expect(localPersonId("ada@example.test")).toBe(localPersonId("ada@example.test"));
    expect(localPersonId("ada@example.test")).not.toBe(localPersonId("grace@example.test"));
  });

  it("a ticket is spent once: the second use gets nothing", () => {
    const issued = issueLocalTicket({ email: "ada@example.test", name: "Ada" }, 1_000);
    if (!issued.ok) throw new Error("expected a ticket");
    expect(consumeLocalTicket(issued.ticket, 2_000)).toMatchObject({ email: "ada@example.test", name: "Ada", emailVerified: true });
    expect(consumeLocalTicket(issued.ticket, 3_000)).toBeNull();
  });

  it("a ticket expires after ten minutes, and an expired one is still removed", () => {
    const issued = issueLocalTicket({ email: "ada@example.test" }, 0);
    if (!issued.ok) throw new Error("expected a ticket");
    expect(consumeLocalTicket(issued.ticket, LOCAL_TICKET_TTL_MS)).toBeNull();
    expect(outstandingLocalTickets()).toBe(0);
    // control: one moment earlier it works
    const again = issueLocalTicket({ email: "ada@example.test" }, 0);
    if (!again.ok) throw new Error("expected a ticket");
    expect(consumeLocalTicket(again.ticket, LOCAL_TICKET_TTL_MS - 1)).not.toBeNull();
  });

  it("an unknown, malformed or non-string ticket gets nothing", () => {
    issueLocalTicket({ email: "ada@example.test" }, 0);
    expect(consumeLocalTicket("x".repeat(43), 1)).toBeNull();
    expect(consumeLocalTicket("short", 1)).toBeNull();
    expect(consumeLocalTicket(undefined, 1)).toBeNull();
    expect(consumeLocalTicket(["a"], 1)).toBeNull();
    expect(outstandingLocalTickets()).toBe(1);
  });

  it("refuses to hold more than the cap of unused tickets, and frees room as they expire", () => {
    for (let i = 0; i < MAX_OUTSTANDING_TICKETS; i++) expect(issueLocalTicket({ email: `p${i}@example.test` }, 0).ok).toBe(true);
    expect(issueLocalTicket({ email: "one-more@example.test" }, 1)).toMatchObject({ ok: false, status: 429 });
    expect(issueLocalTicket({ email: "one-more@example.test" }, LOCAL_TICKET_TTL_MS + 1).ok).toBe(true);
  });
});

describe("POST /v1/admin/sign-in-links", () => {
  it("needs the hub's admin token: none, a wrong one, and no token configured are all refused", async () => {
    expect((await mint({ email: "ada@example.test" }, null)).status).toBe(401);
    expect((await mint({ email: "ada@example.test" }, "wrong-token")).status).toBe(401);
    delete process.env.OPENCADRE_ADMIN_TOKEN;
    // Never open in development, unlike creating an organization.
    expect((await mint({ email: "ada@example.test" }, ADMIN)).status).toBe(503);
    expect(outstandingLocalTickets()).toBe(0);
  });

  it("is refused while a sign-in provider is configured, and mints nothing", async () => {
    process.env.SUPABASE_URL = "https://provider.example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-value";
    const res = await mint({ email: "ada@example.test" });
    expect(res.status).toBe(409);
    expect(outstandingLocalTickets()).toBe(0);
  });

  it("rejects something that is not an email address", async () => {
    expect((await mint({ email: "nope" })).status).toBe(400);
    expect((await mint({})).status).toBe(400);
  });

  it("returns a link on this hub that is never cached", async () => {
    const res = await mint({ email: "ada@example.test", name: "Ada" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { url: string; expiresAt: string };
    expect(body.url.startsWith(`${hub.url}/v1/auth/local?ticket=`)).toBe(true);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("GET /v1/auth/local", () => {
  it("signs the browser in as that person, once", async () => {
    const { url } = await (await mint({ email: "Ada@Example.test", name: "Ada Local" })).json() as { url: string };

    const first = await open(url);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/app/");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const cookie = sessionCookieOf(first);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const who = await me(cookie!);
    expect(who.status).toBe(200);
    const body = await who.json() as { person: { id: string; email: string; name: string }; workspaces: unknown[]; canCreateWorkspace: boolean };
    expect(body.person).toMatchObject({ id: localPersonId("ada@example.test"), email: "ada@example.test", name: "Ada Local" });
    expect(body.workspaces).toEqual([]);
    expect(body.canCreateWorkspace).toBe(true);

    // The same link again: no session, and the same message as any other bad link.
    const second = await open(url);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toMatch(/^\/app\/\?auth_error=/);
    expect(sessionCookieOf(second)).toBeNull();
  });

  it("a second link for the same address signs in the same person", async () => {
    const a = await (await mint({ email: "grace@example.test" })).json() as { url: string };
    const b = await (await mint({ email: "GRACE@example.test" })).json() as { url: string };
    const idOf = async (url: string) => ((await (await me(sessionCookieOf(await open(url))!)).json()) as { person: { id: string } }).person.id;
    expect(await idOf(a.url)).toBe(await idOf(b.url));
  });

  it("an unknown ticket and a missing ticket start no session and say the same thing", async () => {
    const unknown = await open(`${hub.url}/v1/auth/local?ticket=${"z".repeat(43)}`);
    const missing = await open(`${hub.url}/v1/auth/local`);
    expect(sessionCookieOf(unknown)).toBeNull();
    expect(sessionCookieOf(missing)).toBeNull();
    expect(unknown.headers.get("location")).toBe(missing.headers.get("location"));
    expect(unknown.headers.get("location")).toMatch(/^\/app\/\?auth_error=/);
  });

  it("a link minted before a sign-in provider was configured stops working once one is", async () => {
    const { url } = await (await mint({ email: "ada@example.test" })).json() as { url: string };
    process.env.SUPABASE_URL = "https://provider.example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-value";
    const res = await open(url);
    expect(sessionCookieOf(res)).toBeNull();
    expect(res.headers.get("location")).toMatch(/^\/app\/\?auth_error=/);
  });

  it("configuring a provider later ends new links but not a local person's existing session", async () => {
    const { url } = await (await mint({ email: "early@example.test" })).json() as { url: string };
    const cookie = sessionCookieOf(await open(url))!;
    process.env.SUPABASE_URL = "https://provider.example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-value";
    expect((await mint({ email: "late@example.test" })).status).toBe(409);
    // The session started before the provider existed still works (the documented way a hub moves over).
    expect((await me(cookie)).status).toBe(200);
  });

  it("the person it signs in can create a workspace and is its owner", async () => {
    const { url } = await (await mint({ email: "owner@example.test", name: "Owner" })).json() as { url: string };
    const cookie = sessionCookieOf(await open(url))!.split(";")[0];
    const created = await fetch(`${hub.url}/v1/workspaces`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Local Workspace" }),
    });
    expect(created.status).toBe(201);
    const after = await (await fetch(`${hub.url}/v1/auth/me`, { headers: { cookie } })).json() as { workspaces: { name: string; role: string }[] };
    expect(after.workspaces).toHaveLength(1);
    expect(after.workspaces[0]).toMatchObject({ name: "Local Workspace", role: "owner" });
  });
});

describe("the admin token", () => {
  it("a token that is only whitespace counts as not set: the route is unavailable, never open", async () => {
    process.env.OPENCADRE_ADMIN_TOKEN = "   ";
    expect((await mint({ email: "ada@example.test" }, "")).status).toBe(503);
    expect((await mint({ email: "ada@example.test" }, null)).status).toBe(503);
    expect(outstandingLocalTickets()).toBe(0);
  });
});
