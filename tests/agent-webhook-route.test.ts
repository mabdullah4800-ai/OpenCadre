import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { setLogSink } from "../src/log.js";
import { createOrganization, getMessages, listActiveAgents, registerAgent, sendMessage, setAgentWebhook } from "../src/service.js";
import { getAwareness } from "../src/awareness.js";
import { signInPerson } from "./helpers/person.js";

/** A person sets an agent's wake webhook from the console (PUT/GET /v1/org/agents/:agentId/webhook), so an app that
 * can't see its own trigger's key (a Grok Bot routine) never has to carry it. Admin-level; the secret is write-only.
 * Real app over HTTP. */

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
}));
afterEach(() => vi.unstubAllEnvs());

// A made-up value: the test only checks it is stored and never shown again.
const SECRET = "Bearer routine-test-secret-7f3e";
const HOOK = "https://hooks.example.com/routines/abc/run?token=query-part";

let orgCounter = 0;
async function workspace() {
  const { orgId } = createOrganization(`Wake Org ${++orgCounter}`);
  const operator = registerAgent(orgId, "Operator", { role: "operator", system: true });
  const bot = registerAgent(orgId, "Grok Bot");
  const plain = registerAgent(orgId, "Coder");
  // An operator-role tool agent, like a self-serve workspace's "First Agent": it can read what an operator reads.
  const first = registerAgent(orgId, "First Agent", { role: "operator" });
  // A hosted MCP connector's agent (its credential is an OAuth grant, src/oauth.ts): agent role, not a person.
  const connector = registerAgent(orgId, "Claude Connector");
  db.prepare(`UPDATE agents SET kind = 'connector' WHERE id = ?`).run(connector.agentId);
  return {
    orgId,
    operatorKey: operator.apiKey,
    plainKey: plain.apiKey,
    botId: bot.agentId,
    firstId: first.agentId,
    connectorId: connector.agentId,
    owner: await signInPerson(orgId, "Olive", "owner"),
    admin: await signInPerson(orgId, "Adam", "admin"),
    member: await signInPerson(orgId, "Mia", "member"),
  };
}

type Who = { headers: Record<string, string> } | string;
function call(method: string, agentId: string, who: Who, body?: unknown) {
  const headers = typeof who === "string" ? { authorization: `Bearer ${who}`, "content-type": "application/json" } : who.headers;
  return fetch(`${base}/v1/org/agents/${agentId}/webhook`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const hookRow = (agentId: string) =>
  db.prepare(`SELECT webhook_url, webhook_auth_header FROM agents WHERE id = ?`).get(agentId) as { webhook_url: string | null; webhook_auth_header: string | null };
const wakeEvents = (orgId: string) =>
  db.prepare(`SELECT type, actor_agent_name, subject_type, subject_id, payload FROM events WHERE org_id = ? AND type LIKE 'agent.webhook_%' ORDER BY seq`)
    .all(orgId) as Array<{ type: string; actor_agent_name: string; subject_type: string; subject_id: string; payload: string }>;

describe("PUT /v1/org/agents/:agentId/webhook", () => {
  it("an admin sets the URL and header; the header is stored verbatim and never shown back", async () => {
    const w = await workspace();
    const res = await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: true, last_wake: null });
    expect(text).not.toContain("routine-test-secret");
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: SECRET });
  });

  it("an owner, and a bare operator key, may set it too", async () => {
    const w = await workspace();
    expect((await call("PUT", w.botId, w.owner, { url: HOOK, authHeader: SECRET })).status).toBe(200);
    expect((await call("PUT", w.botId, w.operatorKey, { url: HOOK, authHeader: null })).status).toBe(200);
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: null });
  });

  it("an admin may set it on an agent-role agent, a connector's included", async () => {
    const w = await workspace();
    expect((await call("PUT", w.connectorId, w.admin, { url: HOOK, authHeader: SECRET })).status).toBe(200);
    expect(hookRow(w.connectorId)).toEqual({ webhook_url: HOOK, webhook_auth_header: SECRET });
    expect((await call("GET", w.connectorId, w.admin)).status).toBe(200);
  });

  // The wake POST carries the message body and sender (src/service.ts notifyWebhookBestEffort), so whoever sets an
  // agent's wake can read its mail. Nobody may point a person's own agent's wake anywhere, and only an owner may point
  // an operator-role agent's.
  it("nobody may set or read the wake of a person's own agent; it is refused with 403 and unchanged", async () => {
    const w = await workspace();
    for (const target of [w.admin.decider.id, w.owner.decider.id, w.member.decider.id]) {
      for (const who of [w.admin, w.owner, w.operatorKey]) {
        const res = await call("PUT", target, who, { url: HOOK, authHeader: SECRET });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toMatch(/person/);
        expect((await call("GET", target, who)).status).toBe(403);
      }
      expect(hookRow(target)).toEqual({ webhook_url: null, webhook_auth_header: null });
    }
    expect(wakeEvents(w.orgId)).toEqual([]);
  });

  it("only an owner may set or read the wake of an operator-role agent; an admin is refused with 403", async () => {
    const w = await workspace();
    const refused = await call("PUT", w.firstId, w.admin, { url: HOOK, authHeader: SECRET });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/owner/);
    expect((await call("GET", w.firstId, w.admin)).status).toBe(403);
    expect(hookRow(w.firstId)).toEqual({ webhook_url: null, webhook_auth_header: null });
    expect(wakeEvents(w.orgId)).toEqual([]);

    expect((await call("PUT", w.firstId, w.owner, { url: HOOK, authHeader: SECRET })).status).toBe(200);
    expect(hookRow(w.firstId)).toEqual({ webhook_url: HOOK, webhook_auth_header: SECRET });
    expect((await call("GET", w.firstId, w.owner)).status).toBe(200);
    expect((await call("PUT", w.firstId, w.operatorKey, { url: null })).status).toBe(200);
    // An admin still can't clear it either, and another workspace's operator agent stays a plain 404.
    const other = await workspace();
    const unknownBody = await (await call("PUT", "no-such-agent", w.admin, { url: null })).json();
    const cross = await call("PUT", other.firstId, w.admin, { url: null });
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(unknownBody);
  });

  it("a member, or a plain agent key, is refused and nothing changes", async () => {
    const w = await workspace();
    for (const who of [w.member, w.plainKey]) {
      const res = await call("PUT", w.botId, who, { url: HOOK, authHeader: SECRET });
      expect(res.status).toBe(403);
      expect((await call("GET", w.botId, who)).status).toBe(403);
    }
    expect(hookRow(w.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
    expect(wakeEvents(w.orgId)).toEqual([]);
  });

  it("another workspace's agent reads exactly like an unknown id, and is not touched", async () => {
    const w = await workspace();
    const other = await workspace();
    const unknown = await call("PUT", "no-such-agent", w.admin, { url: HOOK });
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();
    const cross = await call("PUT", other.botId, w.admin, { url: HOOK, authHeader: SECRET });
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(unknownBody);
    const crossGet = await call("GET", other.botId, w.admin);
    expect(crossGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(unknownBody);
    expect(hookRow(other.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
    expect(wakeEvents(other.orgId)).toEqual([]);
  });

  it("refuses an invalid or non-public URL, and a malformed body, with 400", async () => {
    const w = await workspace();
    for (const url of ["not a url", "http://hooks.example.com/x", "https://127.0.0.1/x", "https://user:pw@hooks.example.com/x", 42, undefined]) {
      const res = await call("PUT", w.botId, w.admin, { url, authHeader: SECRET });
      expect(res.status, String(url)).toBe(400);
      expect(await res.text()).not.toContain("routine-test-secret");
    }
    expect((await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: 7 })).status).toBe(400);
    expect(hookRow(w.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
  });

  it("refuses a header with a line break or any control character, or over 2048 characters, with 400", async () => {
    const w = await workspace();
    for (const authHeader of [`${SECRET}\r\nX-Injected: 1`, `${SECRET}\n`, `${SECRET}\r`, "Bearer a\u0000b", "Bearer\ta", "Bearer a\u007f", `Bearer ${"a".repeat(2042)}`]) {
      const res = await call("PUT", w.botId, w.admin, { url: HOOK, authHeader });
      expect(res.status, JSON.stringify(authHeader.slice(0, 20))).toBe(400);
      expect(await res.text()).not.toContain("routine-test-secret");
    }
    expect(hookRow(w.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
    const longest = `Bearer ${"a".repeat(2041)}`;
    expect(longest).toHaveLength(2048);
    expect((await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: longest })).status).toBe(200);
    expect(hookRow(w.botId).webhook_auth_header).toBe(longest);
  });

  // On a shared host (a Grok routine URL, webhook.site) routines differ only by path, so the stored key follows the
  // address only when it doesn't move at all: the same URL after parsing, or no url in the request.
  it("an omitted header is kept only for an unchanged address; any other URL, even at the same origin, clears it", async () => {
    const w = await workspace();
    const reset = () => call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    await reset();
    const identical = await call("PUT", w.botId, w.admin, { url: HOOK });
    expect(await identical.json()).toEqual({ ok: true, webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: true, last_wake: null });
    expect(hookRow(w.botId).webhook_auth_header).toBe(SECRET);
    expect((await call("PUT", w.botId, w.admin, {})).status).toBe(200);
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: SECRET });

    // Compared after URL parsing: letter case in the scheme or host, or a default :443, is the same address.
    for (const same of [
      "https://HOOKS.Example.COM/routines/abc/run?token=query-part",
      "HTTPS://hooks.example.com/routines/abc/run?token=query-part",
      "https://hooks.example.com:443/routines/abc/run?token=query-part",
    ]) {
      await reset();
      const res = await call("PUT", w.botId, w.admin, { url: same });
      expect(((await res.json()) as { webhook_auth_set: boolean }).webhook_auth_set, same).toBe(true);
      expect(hookRow(w.botId).webhook_auth_header, same).toBe(SECRET);
    }

    for (const moved of [
      "https://hooks.example.com/routines/someone-else/run?token=query-part", // same origin, another path
      "https://hooks.example.com/routines/abc/run?token=other", // same path, another query
      "https://hooks.example.com./routines/abc/run?token=query-part", // a trailing dot is another host name
      "https://hooks.example.com:8443/routines/abc/run?token=query-part", // another port
      "https://collector.example.net/x", // another host
    ]) {
      await reset();
      const res = await call("PUT", w.botId, w.admin, { url: moved });
      expect(((await res.json()) as { webhook_auth_set: boolean }).webhook_auth_set, moved).toBe(false);
      expect(hookRow(w.botId), moved).toEqual({ webhook_url: moved, webhook_auth_header: null });
    }
  });

  it("an omitted header does not follow https to http (local development, where http is allowed)", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const w = await workspace();
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    const http = HOOK.replace("https:", "http:");
    expect((await call("PUT", w.botId, w.admin, { url: http })).status).toBe(200);
    expect(hookRow(w.botId)).toEqual({ webhook_url: http, webhook_auth_header: null });
  });

  it("an explicit null or empty header clears it; url null clears both", async () => {
    const w = await workspace();
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: "" });
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: null });
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    const nulled = await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: null });
    expect(await nulled.json()).toEqual({ ok: true, webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: false, last_wake: null });
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: null });
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    const cleared = await call("PUT", w.botId, w.admin, { url: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, webhook_host: null, webhook_url_set: false, webhook_auth_set: false, last_wake: null });
    expect(hookRow(w.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
  });

  it("records who set or cleared it on the timeline, with no header and no query string; logs never carry the secret", async () => {
    const w = await workspace();
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
      await call("PUT", w.botId, w.owner, { url: null });
    } finally { restore(); }
    const events = wakeEvents(w.orgId);
    expect(events.map((e) => [e.type, e.actor_agent_name, e.subject_type, e.subject_id])).toEqual([
      ["agent.webhook_set", w.admin.decider.name, "agent", w.botId],
      ["agent.webhook_cleared", w.owner.decider.name, "agent", w.botId],
    ]);
    for (const e of events) {
      expect(e.payload).not.toContain("routine-test-secret");
      expect(e.payload).not.toContain("query-part");
      expect(e.payload).not.toContain("/routines/");
    }
    expect(JSON.parse(events[0].payload)).toMatchObject({ agentName: "Grok Bot", host: "hooks.example.com", authHeaderSet: true });
    expect(JSON.parse(events[0].payload)).not.toHaveProperty("previousHost");
    expect(lines.join("\n")).not.toContain("routine-test-secret");
  });

  it("an overwrite or a clear names the host it replaced (host only)", async () => {
    const w = await workspace();
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    await call("PUT", w.botId, w.owner, { url: "https://collector.example.net/x?k=query-part" });
    await call("PUT", w.botId, w.admin, { url: null });
    const payloads = wakeEvents(w.orgId).map((e) => JSON.parse(e.payload));
    expect(payloads[1]).toMatchObject({ host: "collector.example.net", previousHost: "hooks.example.com" });
    expect(payloads[2]).toMatchObject({ agentName: "Grok Bot", previousHost: "collector.example.net" });
    for (const e of wakeEvents(w.orgId)) expect(e.payload).not.toMatch(/query-part|\/routines\/|\/x/);
  });

  it("an omitted url keeps the stored address, so the header alone can change; with nothing stored it is a 400", async () => {
    const w = await workspace();
    const none = await call("PUT", w.botId, w.admin, { authHeader: SECRET });
    expect(none.status).toBe(400);
    expect(hookRow(w.botId)).toEqual({ webhook_url: null, webhook_auth_header: null });
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    const rekeyed = await call("PUT", w.botId, w.admin, { authHeader: "Bearer routine-test-secret-new" });
    expect(await rekeyed.json()).toEqual({ ok: true, webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: true, last_wake: null });
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: "Bearer routine-test-secret-new" });
    await call("PUT", w.botId, w.admin, { authHeader: null });
    expect(hookRow(w.botId)).toEqual({ webhook_url: HOOK, webhook_auth_header: null });
  });
});

describe("GET /v1/org/agents/:agentId/webhook", () => {
  it("returns the host and whether a URL and a header are set, never the full URL or the header", async () => {
    const w = await workspace();
    const before = await call("GET", w.botId, w.admin);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ webhook_host: null, webhook_url_set: false, webhook_auth_set: false, last_wake: null });
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    for (const who of [w.admin, w.owner, w.operatorKey]) {
      const res = await call("GET", w.botId, who);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ webhook_host: "hooks.example.com", webhook_url_set: true, webhook_auth_set: true, last_wake: null });
      // Only the host comes back: the path and query can carry a token.
      expect(text).not.toContain("query-part");
      expect(text).not.toContain("/routines/");
      expect(text).not.toContain("routine-test-secret");
    }
  });
});

describe("the wake it sets", () => {
  it("a message to the offline agent POSTs to the URL with the header the person saved", async () => {
    const received: Array<{ path: string; authorization?: string }> = [];
    const receiver = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { received.push({ path: req.url ?? "", authorization: req.headers.authorization }); res.end("ok"); });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    try {
      // A real local receiver, so lift the public-https rule the way local development does (as tests/webhook.test.ts).
      vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
      const w = await workspace();
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/routine`;
      expect((await call("PUT", w.botId, w.admin, { url, authHeader: SECRET })).status).toBe(200);
      await sendMessage(w.orgId, { id: w.admin.decider.id, name: w.admin.decider.name }, "Grok Bot", "wake up");
      for (let i = 0; i < 150 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(received).toEqual([{ path: "/routine", authorization: SECRET }]);
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});

/** A local wake receiver answering `status` (a number, or one per call), with a body the hub must never keep. */
async function wakeReceiver(status: number | (() => number) = 200) {
  const received: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
      res.statusCode = typeof status === "number" ? status : status();
      res.end("receiver-response-body-must-not-be-kept");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    received,
    url: (path = "/routine") => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
/** An address nothing listens on, so a wake POST fails at the network. */
async function deadUrl() {
  const r = await wakeReceiver();
  const url = r.url();
  await r.close();
  return url;
}
const inbox = (orgId: string, agentId: string) =>
  getMessages(orgId, agentId, undefined, { peek: true }) as unknown as Array<{ from_agent_name: string; body: string; priority: string }>;
type LastWake = { at: string; outcome: string; status: number | null } | null;
const lastWake = async (w: Awaited<ReturnType<typeof workspace>>) =>
  ((await (await call("GET", w.botId, w.admin)).json()) as { last_wake: LastWake }).last_wake;
function testWake(agentId: string, who: Who) {
  const headers = typeof who === "string" ? { authorization: `Bearer ${who}`, "content-type": "application/json" } : who.headers;
  return fetch(`${base}/v1/org/agents/${agentId}/webhook/test`, { method: "POST", headers, body: "{}" });
}

describe("telling the agent its wake changed", () => {
  it("a person's set or clear sends the agent a message naming the host only", async () => {
    const w = await workspace();
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    await call("PUT", w.botId, w.owner, { url: null });
    const mail = inbox(w.orgId, w.botId);
    expect(mail.map((m) => [m.from_agent_name, m.body])).toEqual([
      [w.admin.decider.name, `${w.admin.name} set your wake webhook to hooks.example.com.`],
      [w.owner.decider.name, `${w.owner.name} cleared your wake webhook.`],
    ]);
    for (const m of mail) expect(m.body).not.toMatch(/routine-test-secret|query-part|\/routines\//);
    expect(getAwareness(w.orgId, w.botId).text).toContain(w.admin.decider.name);
  });

  it("is sent at low priority, so it never fires a wake POST at the address just saved", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver();
    try {
      const w = await workspace();
      expect((await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET })).status).toBe(200);
      expect(inbox(w.orgId, w.botId).map((m) => m.priority)).toEqual(["low"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(r.received).toEqual([]);
    } finally { await r.close(); }
  });

  it("an operator key changing it is named too, as the agent it is", async () => {
    const w = await workspace();
    await call("PUT", w.botId, w.operatorKey, { url: HOOK, authHeader: SECRET });
    await call("PUT", w.botId, w.operatorKey, { url: null });
    expect(inbox(w.orgId, w.botId).map((m) => [m.from_agent_name, m.body, m.priority])).toEqual([
      ["Operator", "Operator set your wake webhook to hooks.example.com.", "low"],
      ["Operator", "Operator cleared your wake webhook.", "low"],
    ]);
  });

  it("a re-PUT that changes nothing sends no second notice", async () => {
    const w = await workspace();
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    // The same URL with the header omitted (kept), and the same URL and header again: neither changes anything.
    expect((await call("PUT", w.botId, w.admin, { url: HOOK })).status).toBe(200);
    expect((await call("PUT", w.botId, w.owner, { url: HOOK, authHeader: SECRET })).status).toBe(200);
    expect(inbox(w.orgId, w.botId)).toHaveLength(1);
    // A real change still tells the agent, and so does clearing it.
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: "Bearer routine-test-secret-new" });
    await call("PUT", w.botId, w.admin, { url: null });
    await call("PUT", w.botId, w.admin, { url: null });
    expect(inbox(w.orgId, w.botId).map((m) => m.body)).toEqual([
      `${w.admin.name} set your wake webhook to hooks.example.com.`,
      `${w.admin.name} set your wake webhook to hooks.example.com.`,
      `${w.admin.name} cleared your wake webhook.`,
    ]);
  });
});

describe("the last wake's outcome", () => {
  it("records delivered, rejected and gave-up outcomes with the status code only, and a new address starts clean", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "10");
    let answer = 200;
    const r = await wakeReceiver(() => answer);
    try {
      const w = await workspace();
      expect(await lastWake(w)).toBeNull();
      await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
      const from = { id: w.admin.decider.id, name: w.admin.decider.name };

      await sendMessage(w.orgId, from, "Grok Bot", "one");
      await vi.waitFor(async () => expect(await lastWake(w)).toMatchObject({ outcome: "delivered", status: 200 }));
      expect((await lastWake(w))!.at).toBeTruthy();

      answer = 401;
      await sendMessage(w.orgId, from, "Grok Bot", "two");
      await vi.waitFor(async () => expect(await lastWake(w)).toMatchObject({ outcome: "rejected", status: 401 }));
      // The stored row keeps the status code, never what the receiver said.
      expect(JSON.stringify(db.prepare(`SELECT * FROM agents WHERE id = ?`).get(w.botId))).not.toContain("receiver-response-body");

      // A new address starts clean (read from the PUT itself: the move also wakes the new address for the waiting mail).
      const moved = await call("PUT", w.botId, w.admin, { url: await deadUrl(), authHeader: SECRET });
      expect(((await moved.json()) as { last_wake: LastWake }).last_wake).toBeNull();
      await sendMessage(w.orgId, from, "Grok Bot", "three");
      await vi.waitFor(async () => expect(await lastWake(w)).toMatchObject({ outcome: "gave_up", status: null }), { timeout: 5000 });
    } finally { await r.close(); }
  });
});

describe("a retry chain after the webhook changes", () => {
  // Retries carry the message body and the header that were current at send time, so once the webhook changes or is
  // cleared, the old chain must stop: never another POST to the old address, and never the old body under the old key.
  const sent = (r: { received: Array<{ body: Record<string, unknown> }> }) => r.received.map((x) => [x.body.body, x.body.attempt]);
  /** Answers 503 to the first POST, then 200: a webhook that was failing and now works. */
  const failsOnce = () => { let n = 0; return () => (n++ === 0 ? 503 : 200); };

  it("stops at once when the webhook is cleared mid-retry, and the clear wakes nothing", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "150,150,150");
    const old = await wakeReceiver(503);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: old.url(), authHeader: SECRET });
      await sendMessage(w.orgId, { id: w.admin.decider.id, name: w.admin.decider.name }, "Grok Bot", "the body");
      await vi.waitFor(() => expect(old.received).toHaveLength(1));
      await call("PUT", w.botId, w.admin, { url: null });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(old.received).toHaveLength(1);
    } finally { await old.close(); }
  });

  // The typical repair: the webhook was failing (a bad key, a 503), so its chain sleeps; a person fixes it. The old chain
  // stops, and the mail already waiting must still reach the fixed webhook without waiting for another message.
  it("fixing a failing webhook wakes the NEW address for the waiting mail at once, with no new message, and the old one never again", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "400,400");
    const old = await wakeReceiver(503);
    const fresh = await wakeReceiver(200);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: old.url(), authHeader: SECRET });
      await sendMessage(w.orgId, { id: w.admin.decider.id, name: w.admin.decider.name }, "Grok Bot", "the body");
      await vi.waitFor(() => expect(old.received).toHaveLength(1));
      await call("PUT", w.botId, w.admin, { url: fresh.url(), authHeader: "Bearer routine-test-secret-new" });
      await vi.waitFor(() => expect(fresh.received).toHaveLength(1), { timeout: 300, interval: 10 });
      expect(fresh.received[0]).toMatchObject({
        authorization: "Bearer routine-test-secret-new",
        body: { type: "message", from: w.admin.decider.name, body: "the body", priority: "medium", attempt: 1 },
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(old.received).toHaveLength(1);
      expect(fresh.received).toHaveLength(1);
    } finally {
      await old.close();
      await fresh.close();
    }
  });

  it("a webhook change with no unread waking mail posts nothing", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(200);
    try {
      const w = await workspace();
      const from = { id: w.admin.decider.id, name: w.admin.decider.name };
      // Before any webhook: one low-priority message (it never wakes anyone) and one medium message already read.
      await sendMessage(w.orgId, from, "Grok Bot", "just so you know", "low");
      await sendMessage(w.orgId, from, "Grok Bot", "already read");
      db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE to_agent_id = ? AND body = 'already read'`).run(w.botId);
      // Straight through setAgentWebhook, so no notice lands on top: "already read" stays the newest message.
      setAgentWebhook(w.orgId, w.botId, r.url(), SECRET);
      setAgentWebhook(w.orgId, w.botId, r.url("/other"), SECRET);
      // Let the re-wake checks run (they are deferred past the change) before the PUT's notice arrives.
      await new Promise((resolve) => setImmediate(resolve));
      await call("PUT", w.botId, w.admin, { url: r.url("/third"), authHeader: SECRET });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(r.received).toEqual([]);
    } finally { await r.close(); }
  });

  it("a new message after the webhook moves wakes the NEW address at once, under the new key, and the old one never again", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "400,400");
    const old = await wakeReceiver(503);
    const fresh = await wakeReceiver(200);
    try {
      const w = await workspace();
      const from = { id: w.admin.decider.id, name: w.admin.decider.name };
      await call("PUT", w.botId, w.admin, { url: old.url(), authHeader: SECRET });
      await sendMessage(w.orgId, from, "Grok Bot", "first");
      await vi.waitFor(() => expect(old.received).toHaveLength(1));
      // The old chain is now sleeping before its retry. "first" gets read another way, so the move itself wakes nothing;
      // then the webhook moves and a new message arrives.
      db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE to_agent_id = ? AND body = 'first'`).run(w.botId);
      await call("PUT", w.botId, w.admin, { url: fresh.url(), authHeader: "Bearer routine-test-secret-new" });
      await sendMessage(w.orgId, from, "Grok Bot", "second");
      // Well inside the old chain's 400 ms sleep: the new address has been woken for "second", under the new key.
      await vi.waitFor(() => expect(fresh.received.map((x) => x.body.body)).toEqual(["second"]), { timeout: 300, interval: 10 });
      expect(fresh.received[0].authorization).toBe("Bearer routine-test-secret-new");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(old.received).toHaveLength(1);
      expect(fresh.received).toHaveLength(1);
    } finally {
      await old.close();
      await fresh.close();
    }
  });

  it("two messages to an unchanged webhook still share one chain", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "400,400");
    const r = await wakeReceiver(503);
    try {
      const w = await workspace();
      const from = { id: w.admin.decider.id, name: w.admin.decider.name };
      await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
      await sendMessage(w.orgId, from, "Grok Bot", "first");
      await vi.waitFor(() => expect(r.received).toHaveLength(1));
      await sendMessage(w.orgId, from, "Grok Bot", "second");
      // A second chain would POST at once; the one chain only POSTs again after its 400 ms sleep.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(r.received).toHaveLength(1);
      await vi.waitFor(() => expect(r.received).toHaveLength(2), { timeout: 1000 });
      expect(r.received.map((x) => x.body.body)).toEqual(["first", "first"]);
    } finally { await r.close(); }
  });

  // Cleared, then set back to the very same URL and header while the old chain sleeps: the old chain must never resume
  // (its retry would be attempt 2). The restore itself wakes the webhook afresh for the waiting mail (attempt 1), and the
  // next message is not "covered" by the dead chain. Every path that sets a webhook goes through setAgentWebhook (the
  // person's PUT, the agent's own POST /v1/webhook and register_webhook).
  for (const via of ["the person's PUT", "setAgentWebhook (the agent's own routes)"] as const) {
    it(`a clear and restore of the same webhook ends the old chain, via ${via}`, async () => {
      vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
      vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "400,400");
      const r = await wakeReceiver(failsOnce());
      try {
        const w = await workspace();
        const from = { id: w.admin.decider.id, name: w.admin.decider.name };
        await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
        await sendMessage(w.orgId, from, "Grok Bot", "first");
        await vi.waitFor(() => expect(r.received).toHaveLength(1));
        if (via === "the person's PUT") {
          await call("PUT", w.botId, w.admin, { url: null });
          await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
        } else {
          setAgentWebhook(w.orgId, w.botId, null, null);
          setAgentWebhook(w.orgId, w.botId, r.url(), SECRET);
        }
        // Past the old chain's 400 ms sleep: only the fresh wake (attempt 1), never the old chain's retry (attempt 2).
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(sent(r)).toEqual([["first", 1], ["first", 1]]);
        await sendMessage(w.orgId, from, "Grok Bot", "second");
        await vi.waitFor(() => expect(sent(r)).toEqual([["first", 1], ["first", 1], ["second", 1]]), { timeout: 300, interval: 10 });
      } finally { await r.close(); }
    });
  }

  it("a stale chain that exits releases only its own slot: the new chain stays the one chain", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "600,600");
    const old = await wakeReceiver(503);
    const fresh = await wakeReceiver(503);
    try {
      const w = await workspace();
      const from = { id: w.admin.decider.id, name: w.admin.decider.name };
      await call("PUT", w.botId, w.admin, { url: old.url(), authHeader: SECRET });
      await sendMessage(w.orgId, from, "Grok Bot", "first");
      await vi.waitFor(() => expect(old.received).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Mid-sleep the webhook moves: the move wakes the new address for "first", which also answers 503, so the new chain
      // sleeps 600 ms.
      await call("PUT", w.botId, w.admin, { url: fresh.url(), authHeader: SECRET });
      await vi.waitFor(() => expect(fresh.received).toHaveLength(1), { timeout: 300, interval: 10 });
      // The old chain wakes about 300 ms later, finds itself stale and exits. Then a new message arrives while the new
      // chain still sleeps: it is covered by the new chain, so nothing is POSTed at once.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await sendMessage(w.orgId, from, "Grok Bot", "third");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sent(fresh)).toEqual([["first", 1]]);
      expect(old.received).toHaveLength(1);
      await vi.waitFor(() => expect(sent(fresh)).toEqual([["first", 1], ["first", 2]]), { timeout: 1000 });
    } finally {
      await old.close();
      await fresh.close();
    }
  });

  // A -> Y -> A with no message after the flips: the agent's webhook is A again, so "is the webhook still what this chain
  // started with?" says yes for the first chain; only "does this chain still own the slot?" stops it.
  it("after A -> Y -> A, the first chain to A never resumes, and the chain to Y stops too", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    vi.stubEnv("OPENCADRE_WEBHOOK_RETRY_MS", "400,400");
    const a = await wakeReceiver(failsOnce());
    const y = await wakeReceiver(503);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: a.url(), authHeader: SECRET });
      await sendMessage(w.orgId, { id: w.admin.decider.id, name: w.admin.decider.name }, "Grok Bot", "first");
      await vi.waitFor(() => expect(a.received).toHaveLength(1));
      await call("PUT", w.botId, w.admin, { url: y.url(), authHeader: SECRET });
      await vi.waitFor(() => expect(y.received).toHaveLength(1), { timeout: 300, interval: 10 });
      await call("PUT", w.botId, w.admin, { url: a.url(), authHeader: SECRET });
      await new Promise((resolve) => setTimeout(resolve, 900));
      // A: the first POST (503), then the restore's fresh wake (200). Never the first chain's retry (attempt 2).
      expect(sent(a)).toEqual([["first", 1], ["first", 1]]);
      expect(sent(y)).toEqual([["first", 1]]);
    } finally {
      await a.close();
      await y.close();
    }
  });
});

describe("POST /v1/org/agents/:agentId/webhook/test", () => {
  it("fires one wake POST with a small test body and the saved header, and returns the outcome", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(200);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
      const res = await testWake(w.botId, w.admin);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, webhook_url_set: true, webhook_auth_set: true, last_wake: { outcome: "delivered", status: 200 } });
      expect(JSON.stringify(body)).not.toMatch(/routine-test-secret|receiver-response-body/);
      expect(r.received).toHaveLength(1);
      expect(r.received[0].authorization).toBe(SECRET);
      // The third party learns only that this is a test: not who asked.
      expect(r.received[0].body).toEqual({ type: "wake.test" });
      expect(await lastWake(w)).toMatchObject({ outcome: "delivered", status: 200 });
    } finally { await r.close(); }
  });

  it("reports a refusal as rejected with its status, and a dead address as failed", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(401);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
      expect(await (await testWake(w.botId, w.admin)).json()).toMatchObject({ last_wake: { outcome: "rejected", status: 401 } });
      await call("PUT", w.botId, w.admin, { url: await deadUrl() });
      expect(await (await testWake(w.botId, w.admin)).json()).toMatchObject({ last_wake: { outcome: "failed", status: null } });
    } finally { await r.close(); }
  });

  it("allows at most 6 test wakes a minute per agent", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(200);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: r.url() });
      for (let i = 0; i < 6; i++) expect((await testWake(w.botId, w.admin)).status).toBe(200);
      const limited = await testWake(w.botId, w.owner);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(r.received).toHaveLength(6);
    } finally { await r.close(); }
  });

  it("allows at most 20 test wakes a minute per workspace, across its agents", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(200);
    try {
      const w = await workspace();
      const fourth = registerAgent(w.orgId, "Fourth Bot").agentId;
      const agents = [w.botId, w.connectorId, fourth, db.prepare(`SELECT id FROM agents WHERE org_id = ? AND name = 'Coder'`).pluck().get(w.orgId) as string];
      for (const id of agents) expect((await call("PUT", id, w.admin, { url: r.url() })).status).toBe(200);
      // 6 + 6 + 6 + 2 = 20 are allowed (each agent within its own 6); the 21st is refused for the workspace.
      for (const [id, n] of [[agents[0], 6], [agents[1], 6], [agents[2], 6], [agents[3], 2]] as const) {
        for (let i = 0; i < n; i++) expect((await testWake(id, w.admin)).status, id).toBe(200);
      }
      const limited = await testWake(agents[3], w.admin);
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: string }).error).toMatch(/workspace/);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(r.received).toHaveLength(20);
      // Another workspace keeps its own budget.
      const other = await workspace();
      await call("PUT", other.botId, other.admin, { url: r.url() });
      expect((await testWake(other.botId, other.admin)).status).toBe(200);
    } finally { await r.close(); }
  });

  it("follows the same permission and target rules, and a missing webhook is a 400", async () => {
    const w = await workspace();
    expect((await testWake(w.botId, w.admin)).status).toBe(400);
    await call("PUT", w.botId, w.admin, { url: HOOK, authHeader: SECRET });
    await call("PUT", w.firstId, w.owner, { url: HOOK, authHeader: SECRET });
    expect((await testWake(w.botId, w.member)).status).toBe(403);
    expect((await testWake(w.botId, w.plainKey)).status).toBe(403);
    expect((await testWake(w.firstId, w.admin)).status).toBe(403);
    expect((await testWake(w.admin.decider.id, w.owner)).status).toBe(403);
    const other = await workspace();
    await call("PUT", other.botId, other.admin, { url: HOOK, authHeader: SECRET });
    const unknownBody = await (await testWake("no-such-agent", w.admin)).json();
    const cross = await testWake(other.botId, w.admin);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(unknownBody);
  });

  it("a wake still in flight when the header changes records nothing against the new header", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    // A receiver that holds its answer until the test releases it, so the header can change mid-POST.
    let arrived = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { arrived = true; void held.then(() => { res.statusCode = 401; res.end(); }); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const w = await workspace();
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/routine`;
      await call("PUT", w.botId, w.admin, { url, authHeader: SECRET });
      const pending = testWake(w.botId, w.admin);
      await vi.waitFor(() => expect(arrived).toBe(true));
      // The same address, a new key: the 401 about to come back answered the OLD key, so it must not describe this one.
      await call("PUT", w.botId, w.admin, { url, authHeader: "Bearer routine-test-secret-new" });
      release();
      expect(((await (await pending).json()) as { last_wake: LastWake }).last_wake).toBeNull();
      expect(await lastWake(w)).toBeNull();
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the roster", () => {
  it("never carries an agent's last wake, not even on the agent's own row", async () => {
    vi.stubEnv("OPENCADRE_WEBHOOK_ALLOW_PRIVATE", "1");
    const r = await wakeReceiver(401);
    try {
      const w = await workspace();
      await call("PUT", w.botId, w.admin, { url: r.url(), authHeader: SECRET });
      await testWake(w.botId, w.admin);
      expect(await lastWake(w)).toMatchObject({ outcome: "rejected", status: 401 });
      const keys = ["last_wake_at", "last_wake_outcome", "last_wake_status"];
      for (const viewer of [undefined, w.botId]) {
        const bot = listActiveAgents(w.orgId, viewer).find((a) => a.id === w.botId)!;
        expect(bot, String(viewer)).toBeTruthy();
        for (const key of keys) expect(bot, `${key} (viewer ${viewer})`).not.toHaveProperty(key);
      }
      const res = await fetch(`${base}/v1/agents`, { headers: { authorization: `Bearer ${w.operatorKey}` } });
      const { agents } = (await res.json()) as { agents: Array<Record<string, unknown>> };
      const row = agents.find((a) => a.id === w.botId)!;
      expect(row).toBeTruthy();
      for (const key of keys) expect(row).not.toHaveProperty(key);
    } finally { await r.close(); }
  });
});
