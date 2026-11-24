// OpenCode: every tool call from a chat reaches the hub as THAT chat, on THAT chat's own hub session.
//
// WHAT WAS WRONG, measured 2026-09-23 on OpenCode v2.0.10 on the fleet PC: an `opencode run` chat's set_status came
// back "This API key doesn't match the agent this MCP session belongs to. (HTTP 401)" while OpenCode printed DONE.
// OpenCode runs ONE MCP child for the whole app and names each chat on each call (`_meta["ai.opencode/sessionID"]`).
// The proxy rebuilt its headers under the chat's id but kept the hub session `initialize` had opened as the app-start
// seat, and the hub binds a session to the agent that opened it. The fix routes the chat id through the per-chat
// channel a Codex stamp uses: the chat's own headers AND its own session.
//
// The stand-in hub keeps the real hub's rule (src/mcp.ts routeMcpTransport): a session is refused to any other
// identity with 401. Every arm below fails on the header-rebuild version (the calls are refused), named in its comment.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { childEnv, ProxyProcess, tempDir } from "./helpers/device-hub.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const PROXY = path.join(process.cwd(), "scripts", "opencadre-mcp.mjs");
const CREDENTIAL = `dev_${"b".repeat(48)}`;
const META = "ai.opencode/sessionID";

function seededHome(hub: string) {
  const home = tempDir("oc-opencode-channel-home-");
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential: CREDENTIAL, deviceId: "dev-test" } }));
  return home;
}

/** Records every request; sessions are `s-<identity>`, and one used by another identity is refused 401. */
async function recordingHub() {
  const seen: Array<{ session: string | undefined; mcpSession: string | undefined; status: number; body: any }> = [];
  const current = new Map<string, string>();
  const owners = new Map<string, string>();
  const openings = new Map<string, number>();
  const delayExpired = new Set<string>();
  const delayedReplies = new Map<string, () => void>();
  const delaySuccess = new Set<string>();
  const delayedSuccessReplies = new Map<string, () => void>();
  const failInitializedOnce = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const session = req.headers["x-opencadre-session"] as string | undefined;
      const mcpSession = req.headers["mcp-session-id"] as string | undefined;
      const answer = (status: number, headers: Record<string, string>, payload?: unknown) => {
        seen.push({ session, mcpSession, status, body });
        res.writeHead(status, headers).end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (mcpSession) {
        if (owners.has(mcpSession) && owners.get(mcpSession) !== session) {
          answer(401, { "content-type": "application/json" }, { error: "This API key doesn't match the agent this MCP session belongs to." });
          return;
        }
        if (current.get(session ?? "") !== mcpSession) {
          const expired = () => answer(404, { "content-type": "application/json" }, { error: "MCP session expired" });
          if (session && delayExpired.delete(session)) delayedReplies.set(session, expired);
          else expired();
          return;
        }
      }
      if (body?.id === undefined) {
        if (body?.method === "notifications/initialized" && session && failInitializedOnce.delete(session)) {
          current.delete(session); // hub restarted after initialize, before this acknowledgement
          return answer(404, { "content-type": "application/json" }, { error: "MCP session expired" });
        }
        return answer(202, {});
      }
      let opened = current.get(session ?? "");
      if (body.method === "initialize") {
        const count = (openings.get(session ?? "") ?? 0) + 1;
        openings.set(session ?? "", count);
        opened = `s-${session}${count === 1 ? "" : `-${count}`}`;
        current.set(session ?? "", opened);
        owners.set(opened, session ?? "");
      }
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "opencadre", version: "t" } }
        : { content: [{ type: "text", text: "ok" }] };
      const success = () => answer(200, { "content-type": "application/json", "mcp-session-id": opened ?? "" }, { jsonrpc: "2.0", id: body.id, result });
      if (body.method === "tools/call" && session && delaySuccess.delete(session)) delayedSuccessReplies.set(session, success);
      else success();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, seen,
    expire: (session: string) => current.delete(session),
    sessionFor: (session: string) => current.get(session),
    delayOneExpiredReply: (session: string) => delayExpired.add(session),
    releaseExpiredReply: (session: string) => {
      const reply = delayedReplies.get(session);
      delayedReplies.delete(session);
      reply?.();
    },
    delayOneSuccess: (session: string) => delaySuccess.add(session),
    failNextInitializedAck: (session: string) => failInitializedOnce.add(session),
    hasDelayedSuccess: (session: string) => delayedSuccessReplies.has(session),
    releaseSuccess: (session: string) => {
      const reply = delayedSuccessReplies.get(session);
      delayedSuccessReplies.delete(session);
      reply?.();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("OpenCode: a chat's calls go out as that chat, on its own hub session", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let hub: Awaited<ReturnType<typeof recordingHub>>;
  let proxy: ProxyProcess;
  beforeAll(async () => {
    hub = await recordingHub();
    proxy = new ProxyProcess(PROXY, childEnv(seededHome(hub.url)), tempDir("oc-opencode-channel-cwd-"), "opencode");
    expect((await proxy.initialize()).error).toBeUndefined();
  });
  afterAll(async () => {
    await proxy.close();
    await hub.close();
  });
  const calls = () => hub.seen.filter((s) => s.body?.method === "tools/call");
  const callAs = (chat: string, task: string) =>
    proxy.request("tools/call", { name: "set_status", arguments: { task }, _meta: { [META]: chat } });

  it("the initialize went out on the app-start seat, not as any chat", () => {
    const init = hub.seen.find((s) => s.body?.method === "initialize")!;
    expect(init.session).toMatch(/^opencode-/);
  });

  // Fails on the header-rebuild version: the call carries chat A's id on the app-start seat's session → 401.
  it("chat A's call is answered, as chat A, on chat A's own session", async () => {
    const res = await callAs("ses_A", "as A");
    expect(res.error).toBeUndefined();
    const last = calls().at(-1)!;
    expect(last.status).toBe(200);
    expect(last.session).toBe("ses_A");
    expect(last.mcpSession).toBe("s-ses_A");
  });

  it("chat B on the same child is answered as chat B, on its own session, and chat A still works after it", async () => {
    expect((await callAs("ses_B", "as B")).error).toBeUndefined();
    expect(calls().at(-1)).toMatchObject({ status: 200, session: "ses_B", mcpSession: "s-ses_B" });
    expect((await callAs("ses_A", "A again")).error).toBeUndefined();
    expect(calls().at(-1)).toMatchObject({ status: 200, session: "ses_A", mcpSession: "s-ses_A" });
  });

  it("reopens an expired chat session once for concurrent calls and keeps the other chat intact", async () => {
    const before = hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize").length;
    expect(hub.expire("ses_A")).toBe(true);
    hub.delayOneExpiredReply("ses_A");
    const ids = Array.from({ length: 8 }, (_, index) => 20_000 + index);
    for (const id of ids) proxy.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "set_status", arguments: { task: "after expiry" }, _meta: { [META]: "ses_A" } } });
    const replies = Promise.all(ids.map((id) => proxy.response(id)));
    try {
      // The delayed old 404 arrives only after another call has used the reopened session.
      await vi.waitFor(() => expect(hub.seen.some((s) => ids.includes(s.body?.id) && s.status === 200)).toBe(true));
    } finally {
      hub.releaseExpiredReply("ses_A");
    }
    for (const reply of await replies) expect(reply.error).toBeUndefined();
    expect(hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize")).toHaveLength(before + 1);
    expect(hub.seen.filter((s) => ids.includes(s.body?.id) && s.status === 200)).toHaveLength(ids.length);
    expect((await callAs("ses_B", "still B")).error).toBeUndefined();
    expect(calls().at(-1)).toMatchObject({ status: 200, session: "ses_B", mcpSession: "s-ses_B" });
  });

  it("keeps a recovered session when an older successful reply arrives late", async () => {
    const oldSession = hub.sessionFor("ses_A");
    hub.delayOneSuccess("ses_A");
    const oldCall = callAs("ses_A", "in flight before restart");
    await vi.waitFor(() => expect(hub.hasDelayedSuccess("ses_A")).toBe(true));
    expect(hub.expire("ses_A")).toBe(true);
    expect((await callAs("ses_A", "recover after restart")).error).toBeUndefined();
    const recovered = hub.sessionFor("ses_A");
    expect(recovered).not.toBe(oldSession);
    const opens = hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize").length;
    hub.releaseSuccess("ses_A");
    expect((await oldCall).error).toBeUndefined();
    expect((await callAs("ses_A", "after late success")).error).toBeUndefined();
    expect(calls().at(-1)?.mcpSession).toBe(recovered);
    expect(hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize")).toHaveLength(opens);
  });

  it("retries a recovery handshake if the hub expires it before initialized acknowledgement", async () => {
    expect((await callAs("ses_A", "establish chat before restart")).error).toBeUndefined();
    const before = hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize").length;
    expect(hub.expire("ses_A")).toBe(true);
    hub.failNextInitializedAck("ses_A");
    const res = await callAs("ses_A", "after restart during handshake");
    expect(res.error).toBeUndefined();
    expect(hub.seen.filter((s) => s.session === "ses_A" && s.body?.method === "initialize")).toHaveLength(before + 2);
    expect(calls().at(-1)).toMatchObject({ status: 200, session: "ses_A", mcpSession: hub.sessionFor("ses_A") });
  });

  it("no request was ever refused", () => {
    expect(hub.seen.filter((s) => s.status === 401)).toEqual([]);
  });
});

// Review findings (Codex-OpenCadre-8160 on 557757c). Each arm is red on 557757c's callChannelFor.
describe("OpenCode: a call the proxy cannot attribute honestly is refused, not sent", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let hub: Awaited<ReturnType<typeof recordingHub>>;
  let proxy: ProxyProcess;
  beforeAll(async () => {
    hub = await recordingHub();
    proxy = new ProxyProcess(PROXY, childEnv(seededHome(hub.url)), tempDir("oc-opencode-channel-cwd-"), "opencode");
    expect((await proxy.initialize()).error).toBeUndefined();
  });
  afterAll(async () => {
    await proxy.close();
    await hub.close();
  });

  // 557757c sent the whole batch on chat A's channel, so the unnamed call ran as chat A.
  it("a batch mixing a chat's call with an unnamed call is refused whole, and nothing reaches the hub", async () => {
    const before = hub.seen.length;
    proxy.write([
      { jsonrpc: "2.0", id: "b1", method: "tools/call", params: { name: "set_status", arguments: { task: "A" }, _meta: { [META]: "ses_A" } } },
      { jsonrpc: "2.0", id: "b2", method: "tools/call", params: { name: "set_status", arguments: { task: "unnamed" } } },
    ]);
    expect((await proxy.response("b1")).error?.message).toMatch(/mixed a chat's tool call with an unnamed one/);
    expect((await proxy.response("b2")).error?.message).toMatch(/mixed a chat's tool call with an unnamed one/);
    expect(hub.seen.length).toBe(before);
  });

  // 557757c ignored a malformed id and sent the call on the app-start seat: a different identity than the sender.
  it("a present but unusable chat id is refused locally, never sent as the app-start seat", async () => {
    const before = hub.seen.length;
    const res = await proxy.request("tools/call", { name: "set_status", arguments: { task: "bad id" }, _meta: { [META]: "" } });
    expect(res.error?.message).toMatch(/chat id .* was unusable/);
    expect(hub.seen.length).toBe(before);
  });

  // 943e88a treated a present-but-null id as unnamed and sent the call on the app-start seat.
  it("a present but null chat id is refused the same way, never sent as the app-start seat", async () => {
    const before = hub.seen.length;
    const res = await proxy.request("tools/call", { name: "set_status", arguments: { task: "null id" }, _meta: { [META]: null } });
    expect(res.error?.message).toMatch(/chat id .* was unusable/);
    expect(hub.seen.length).toBe(before);
  });

  // An id on anything but a tools/call is not the proof a chat is behind it, so it opens no chat channel.
  it("an id on a non-call request opens no chat channel: the request goes out on the app-start seat", async () => {
    await proxy.request("tools/list", { _meta: { [META]: "ses_C" } });
    const last = hub.seen.at(-1)!;
    expect(last.body.method).toBe("tools/list");
    expect(last.session).toMatch(/^opencode-/);
  });
});
