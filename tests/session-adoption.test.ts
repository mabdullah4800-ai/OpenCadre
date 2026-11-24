/** A chat whose tool hands it no per-chat id to its own MCP child (Codex) can still reach the identity
 * the proxy created for it -- by ADOPTION, never by guessing.
 *
 * WHY THIS EXISTS: the MCP proxy mints the seat id (`codex-<uuid>`, sessionIdSource from:"process") while the
 * hook carries Codex's OWN session_id, which is a different value the hook cannot learn (measured: Codex gives
 * an MCP child no per-chat value in env, argv, initialize params, ppid or cwd -- docs/design/HARNESS-CODEX.md
 * §5.4.1). The hub resolves hostSessionId || toolSessionId, so the two halves land on different seats and the
 * resolve-only hook finds no row: NO OUTPUT at all, an inert hook and an inert Stop unread-mail gate (#346).
 * The hook-side fix is dead, so convergence has to come from the hub.
 *
 * THE RULING (508d, decision #13378): a resolve-only caller that opted in may ADOPT the single live session
 * this device already has in this project; with more than one candidate the hub refuses LOUDLY rather than
 * picking one -- "adoption a deduction rather than a guess".
 *
 * WHAT THIS PINS, and the two boundaries that make it safe:
 *   - the opt-in header is required (scope (b)). Without it a resolve-only request is byte-for-byte the
 *     behaviour it had before, so an ordinary Claude Code chat -- whose id is real and whose source is not
 *     "process" -- can never silently wear another live chat's identity in the same folder.
 *   - a candidate that is not the single one in the project is never adopted: two live Codex chats are
 *     ambiguous, and a candidate in a different project is not this chat's to take.
 */
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { db } from "../src/db.js";
import { adoptableLiveSession } from "../src/devices.js";
import { createOrganization, registerAgent } from "../src/service.js";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => app(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let ipCounter = 0;
const nextIp = () => `10.79.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, path: string, { key, body, headers = {} }: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-forwarded-for": nextIp(),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const REPO = { key: "github.com/acme/codexrepo", name: "CodexRepo" };
const OTHER = { key: "github.com/acme/otherrepo", name: "OtherRepo" };
const project = (p: { key: string; name: string }) => ({ "x-opencadre-project": p.key, "x-opencadre-project-name": p.name });

/** A connected computer. Only a device credential reaches /v1/sessions/join.
 *
 * `client` is the DEVICE's own tool, and it decides where a session's tool comes from (src/devices.ts sessionTool):
 * "codex" pins every session on the machine to Codex whatever a request says; "auto" lets each session declare its
 * own. "auto" is the shape a machine running BOTH clients has, and the only one in which a Codex hook and a live
 * Claude Code chat can share a device -- so it is the only one in which the client-filter below can be exercised. */
async function computer(client = "codex") {
  const { orgId } = createOrganization(`Adoption Org ${Math.random().toString(36).slice(2, 8)}`);
  const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
  const minted = await call("POST", "/v1/org/devices", { key: operatorKey, body: { name: "Codex box", client } });
  const redeemed = await call("POST", "/v1/connect/redeem", { body: { code: minted.body.code } });
  for (const p of [REPO, OTHER]) await call("PUT", "/v1/org/projects", { key: operatorKey, body: { projectKey: p.key, enabled: true, name: p.name } });
  return { orgId, operatorKey, deviceId: minted.body.deviceId as string, credential: redeemed.body.deviceCredential as string };
}

/** The common case: a Codex-only machine. */
const codexComputer = () => computer("codex");

type C = Awaited<ReturnType<typeof computer>>;

/** Any chat joining: the tool is the caller's to declare, and the add-live opt-in is not involved. */
const joinAs = (c: C, client: string, seat: string, p = REPO) =>
  call("POST", "/v1/sessions/join", {
    key: c.credential,
    headers: { "x-opencadre-session": seat, "x-opencadre-client": client, ...project(p) },
  });

/** The MCP proxy: the ONE creator an ordinary device-connected chat has. It mints the seat and creates the agent. */
const proxyJoin = (c: C, minted: string, p = REPO) => joinAs(c, "codex", minted, p);

/** The hook: resolve-only, the chat's OWN id (never the proxy's), and -- for a process-derived client -- the opt-in. */
const hookJoin = (c: C, chatId: string, { adopt = true, p = REPO, host }: { adopt?: boolean; p?: { key: string; name: string }; host?: string } = {}) =>
  call("POST", "/v1/sessions/join", {
    key: c.credential,
    headers: {
      "x-opencadre-session": chatId,
      "x-opencadre-client": "codex",
      "x-opencadre-resolve-only": "1",
      ...(adopt ? { "x-opencadre-adopt-live": "1" } : {}),
      ...(host ? { "x-opencadre-host-session": host } : {}),
      ...project(p),
    },
  });

const sessionAgentCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND kind = 'session'`).get(orgId) as { n: number }).n;
const toolSessionOf = (agentId: string) => (db.prepare(`SELECT tool_session_id FROM agents WHERE id = ?`).get(agentId) as { tool_session_id: string }).tool_session_id;

// The ids are the whole point: Codex's own chat id and the proxy's minted seat are DIFFERENT values, and only
// the proxy's exists on the hub. If a fix ever made these equal, every test below would pass vacuously.
const MINTED = "codex-11111111-2222-3333-4444-555555555555";
const CHAT_ID = "01a0b792-a301-7953-a642-634effc248aa";

describe("a resolve-only chat adopts the live session its own proxy created", () => {
  it("adopts the single live candidate: same agent, no new row, nothing renamed", async () => {
    const c = await codexComputer();
    const created = await proxyJoin(c, MINTED);
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    const before = sessionAgentCount(c.orgId);

    const adopted = await hookJoin(c, CHAT_ID);
    expect(adopted.status).toBe(200);
    expect(adopted.body).toEqual({ agentId: created.body.agentId, agentName: created.body.agentName, created: false });
    // Adoption is a lookup, not a creation.
    expect(sessionAgentCount(c.orgId)).toBe(before);
    // And it must leave the seat alone: re-pointing tool_session_id at the adopting chat would lock the
    // proxy out of the row it owns on its very next call, which is the inversion of this fix.
    expect(toolSessionOf(created.body.agentId)).toBe(MINTED);
  });

  it("still resolves the proxy's own call afterwards, from both ids", async () => {
    const c = await codexComputer();
    const created = await proxyJoin(c, MINTED);
    await hookJoin(c, CHAT_ID);

    const again = await proxyJoin(c, MINTED);
    expect(again.status).toBe(200);
    expect(again.body.agentId).toBe(created.body.agentId);
    expect(again.body.created).toBe(false);
  });

  it("with two live candidates it refuses LOUDLY and names neither", async () => {
    const c = await codexComputer();
    const a = await proxyJoin(c, "codex-aaaaaaaa-0000-0000-0000-00000000000a");
    const b = await proxyJoin(c, "codex-bbbbbbbb-0000-0000-0000-00000000000b");
    expect(a.body.agentName).not.toBe(b.body.agentName);
    const before = sessionAgentCount(c.orgId);

    const refused = await hookJoin(c, CHAT_ID);
    // A distinct status, so the hook can tell "ambiguous" from "no session yet" without matching prose.
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/more than one/i);
    // The refusal must not leak the choice it declined to make.
    const said = JSON.stringify(refused.body);
    expect(said).not.toContain(a.body.agentName);
    expect(said).not.toContain(b.body.agentName);
    expect(sessionAgentCount(c.orgId)).toBe(before);
  });

  it("a candidate in another project is not this chat's to take", async () => {
    const c = await codexComputer();
    await proxyJoin(c, MINTED, OTHER);

    // One live session on the device, but in a different repo: not a candidate, so this is still no session.
    expect((await hookJoin(c, CHAT_ID, { p: REPO })).status).toBe(401);
    // In its own project it is the single candidate, and adoption is exactly what should happen.
    expect((await hookJoin(c, CHAT_ID, { p: OTHER })).status).toBe(200);
  });

  it("two candidates in different projects are each unambiguous in their own project", async () => {
    const c = await codexComputer();
    const here = await proxyJoin(c, "codex-cccccccc-0000-0000-0000-00000000000c", REPO);
    const there = await proxyJoin(c, "codex-dddddddd-0000-0000-0000-00000000000d", OTHER);

    expect((await hookJoin(c, CHAT_ID, { p: REPO })).body.agentName).toBe(here.body.agentName);
    expect((await hookJoin(c, CHAT_ID, { p: OTHER })).body.agentName).toBe(there.body.agentName);
  });

  it("a chat that declared a host seat is not adopted into a different one", async () => {
    // hostSessionId means the caller knows exactly which seat it is; adopting past it would be a guess.
    const c = await codexComputer();
    await proxyJoin(c, MINTED);
    expect((await hookJoin(c, CHAT_ID, { host: "some-host-seat" })).status).toBe(401);
  });
});

describe("adoption is opt-in, so no other client's identity can move", () => {
  it("without the opt-in header a resolve-only request is unchanged: no session, no adoption", async () => {
    // The load-bearing scope test. An ordinary Claude Code chat in the same folder as a live Codex
    // session must NOT borrow it: a silent wrong identity is the exact defect this area exists to stop.
    const c = await codexComputer();
    const created = await proxyJoin(c, MINTED);

    const refused = await hookJoin(c, CHAT_ID, { adopt: false });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("no OpenCadre session for this chat yet");
    expect(toolSessionOf(created.body.agentId)).toBe(MINTED);
  });

  it("an adopting caller still gets no_session when there is nothing to adopt", async () => {
    const c = await codexComputer();
    const refused = await hookJoin(c, CHAT_ID);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("no OpenCadre session for this chat yet");
    expect(sessionAgentCount(c.orgId)).toBe(0);
  });

  it("the proxy's own creating call never adopts: a second chat gets its own agent", async () => {
    // Adoption sits on the resolve-only refusal, so the create path is untouched by construction. If it
    // ever moved, two chats would collapse onto one agent -- job 1 of the sprint, undone.
    const c = await codexComputer();
    const first = await proxyJoin(c, MINTED);
    const second = await proxyJoin(c, "codex-eeeeeeee-0000-0000-0000-00000000000e");
    expect(second.status).toBe(201);
    expect(second.body.agentId).not.toBe(first.body.agentId);
    expect(sessionAgentCount(c.orgId)).toBe(2);
  });
});

describe("adoption is scoped by TOOL, so one computer's tools cannot wear each other", () => {
  it("a Codex hook does NOT adopt the live Claude Code chat beside it", async () => {
    // THE collision this filter exists for. A device is one COMPUTER, and one computer runs several tools at
    // once; "the live session on this device in this project" is therefore one row PER TOOL, not one row.
    // Without `client = ?` a Codex hook -- which arrives with Codex's own unlearnable chat id -- would adopt
    // whichever of them sorted first, and a Claude Code chat would find itself answering as a Codex agent.
    //
    // The device must be "auto" to even express this: a `client: "codex"` device pins EVERY session on the
    // machine to codex (src/devices.ts sessionTool), so a Claude Code row can never exist on it.
    const c = await computer("auto");
    const claude = await joinAs(c, "claude-code", "claude-chat-seat");
    expect(claude.status).toBe(201);
    expect(claude.body.created).toBe(true);
    const before = sessionAgentCount(c.orgId);

    const refused = await hookJoin(c, CHAT_ID);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("no OpenCadre session for this chat yet");
    // The refusal must be anonymous: naming the Claude Code agent would be the identity leak, stated rather
    // than performed, and a caller can read a name out of a body as easily as out of a 200.
    expect(JSON.stringify(refused.body)).not.toContain(claude.body.agentName);
    expect(sessionAgentCount(c.orgId)).toBe(before);

    // Positive control: the SAME request, on a codex device, adopts -- so the 401 above is the client filter
    // answering, not adoption being broken generally. Without this the test passes if adoption never ran.
    const d = await codexComputer();
    await proxyJoin(d, MINTED);
    expect((await hookJoin(d, CHAT_ID)).status).toBe(200);
  });
});

describe("adoption's own guards, driven directly", () => {
  // These two guards are UNREACHABLE over HTTP, and that is why they are tested here rather than through
  // /v1/sessions/join. A request with no project is refused by touchProject with 403 project_not_enabled
  // BEFORE adoption runs, and resolveProjectKey always returns a string for an enabled project
  // (src/migrations.ts createLegacyAlias) -- so an HTTP-level test of "no home" would pass for a reason that
  // has nothing to do with this function, and would keep passing if the guard were deleted. The honest
  // red-first evidence is the parameter contract itself.

  it("declines when the request resolves to no project home", async () => {
    const c = await codexComputer();
    const created = await proxyJoin(c, MINTED);

    // The guard: an absent home must DECLINE, never widen to the whole device. Widening is the fail-open
    // direction -- it would let a request that named no project adopt a live session in any project.
    expect(adoptableLiveSession(c.orgId, c.deviceId, {}, undefined, "codex")).toBe("none");
    // Positive control, same call with the home the candidate actually has: the miss above is the guard
    // firing, not the query failing to find the row at all.
    expect(adoptableLiveSession(c.orgId, c.deviceId, {}, REPO.key, "codex")).toEqual({ id: created.body.agentId, name: created.body.agentName });
  });

  it("declines when the tool is unknown, and never returns a candidate for it", async () => {
    const c = await codexComputer();
    await proxyJoin(c, MINTED);

    // An unattributable request is not adoptable: `client = NULL` would match nothing in SQL anyway, but the
    // guard is what makes that a decision rather than a coincidence of null semantics.
    expect(adoptableLiveSession(c.orgId, c.deviceId, {}, REPO.key, null)).toBe("none");
    expect(adoptableLiveSession(c.orgId, c.deviceId, {}, REPO.key, "claude-code")).toBe("none");
  });
});
