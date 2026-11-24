import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { childEnv, CLI, computerCredential, enableProject, gitProject, liveSessions, mintDevice, operatorWorkspace, ProxyProcess, runNode, startHub, tempDir } from "./helpers/device-hub.js";
import { db } from "../src/db.js";

/**
 * `agents.liveness` records whether a CHAT is behind a session row, not merely whether a process started.
 *
 * Ruling #16116 stands and this does not repeal it: a chatless `initialize` STILL creates a row (see
 * tests/mcp-proxy.test.ts:434, which must stay green). What changes is that the row now carries a label
 * saying what is known about it, so the console can show chats as agents and group the rest as background
 * processes — the phantom problem solved by NAMING it rather than by suppressing it.
 *
 * The label's contract, and both halves are asserted because neither is evidence alone:
 *   - a session that only initializes is `process`  (the phantom shape, and an idle chat too)
 *   - the first `tools/call` promotes it to `chat`  (the one signal a phantom never produces)
 * Without the second, "everything is process" would pass; without the first, "everything is chat" would.
 */

let hub: Awaited<ReturnType<typeof startHub>>;
let operatorKey: string;
let deviceId: string;
let home: string;
let proxyScript: string;
let project: string;
const proxies: ProxyProcess[] = [];

const livenessOf = (agentId: string): string | null =>
  (db.prepare(`SELECT liveness FROM agents WHERE id = ?`).get(agentId) as { liveness: string | null } | undefined)?.liveness ?? null;

/** This project's live sessions, keyed by agentId. */
async function mine(): Promise<Map<string, string>> {
  const rows = (await liveSessions(hub.url, operatorKey, deviceId)).filter((s) => s.projectKey === "local:liveness-proj");
  return new Map(rows.map((s) => [s.agentId, s.agentName]));
}

/**
 * Start a proxy and return the ONE row it created — identified by set difference, never by position.
 * The first draft of this test took `[0]` from the project's sessions, which is not necessarily the
 * proxy just started: a killed proxy's row can still be live, so `[0]` intermittently pointed at a
 * different session and the promotion assertion failed about half the time. A flaky test here would
 * have been read as a flaky FEATURE, which is why it is fixed rather than retried.
 */
async function startAndIdentify(): Promise<{ proxy: ProxyProcess; agentId: string }> {
  const before = await mine();
  const proxy = new ProxyProcess(proxyScript, childEnv(home), project, "codex");
  proxies.push(proxy);
  await proxy.initialize();
  const after = await mine();
  const created = [...after.keys()].filter((id) => !before.has(id));
  expect(created, "the proxy creates exactly one new row").toHaveLength(1);
  return { proxy, agentId: created[0] };
}

/** A codex proxy with no chat behind it — the phantom shape. */
function startCodexProxy() {
  const proxy = new ProxyProcess(proxyScript, childEnv(home), project, "codex");
  proxies.push(proxy);
  return proxy;
}

beforeAll(async () => {
  project = gitProject("liveness-proj");
  home = tempDir("liveness-home-");
  hub = await startHub();
  ({ operatorKey } = await operatorWorkspace("Liveness Org"));
  await enableProject(hub.url, operatorKey, "local:liveness-proj");
  const minted = await mintDevice(hub.url, operatorKey, "codex");
  const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "codex"], childEnv(home));
  expect(connected.err).toBe("");
  expect(connected.code).toBe(0);
  expect(computerCredential(home)).toMatch(/^dev_[0-9a-f]{48}$/);
  deviceId = minted.deviceId;
  proxyScript = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
}, 60_000);

afterAll(async () => {
  for (const p of proxies) p.child.kill();
  await hub?.close();
});

describe("agents.liveness labels a session row by what is known about it", () => {
  it("stays 'process' for a session that only initializes — the row is still created (ruling #16116)", async () => {
    // THE ROW EXISTS and that is the assertion #16116 protects; the sibling at mcp-proxy.test.ts:434
    // checks the same thing from the other side. A fix that suppressed it would break per-chat identity
    // and waking for every idle chat, which is why that approach was rejected.
    const { proxy, agentId } = await startAndIdentify();
    proxy.notify("notifications/initialized");

    // ...and it is labelled for what it is. An idle chat is ALSO 'process' at this point, which is why
    // the label must never be read as "dead" — only as "a chat is not yet proven".
    expect(livenessOf(agentId), "not yet proven").toBe("process");
    proxy.child.kill();
  }, 30_000);

  it("promotes to 'chat' on the first tools/call, and the row is the same one", async () => {
    const { proxy, agentId } = await startAndIdentify();
    proxy.notify("notifications/initialized");
    await proxy.request("tools/list");
    // tools/list is setup and is NOT the proof — a phantom does it too (measured: the phantom-shaped
    // sequence is initialize, resources/list, cancel). So the label must still be 'process' here.
    expect(livenessOf(agentId), "tools/list is not proof of a chat").toBe("process");
    const rowsBeforeCall = (await mine()).size;

    await proxy.callTool("get_active_agents");

    // Promoted IN PLACE: same agent, same row. A promotion that created a second row would leave behind
    // the phantom it was meant to label, which is the thing this whole change exists to avoid.
    expect(livenessOf(agentId), "the first tool call proves the chat").toBe("chat");
    expect((await mine()).size, "promotion must not mint a second row").toBe(rowsBeforeCall);
    proxy.child.kill();
  }, 30_000);

  it("is one-way: a later chatless request cannot demote a promoted row", async () => {
    // The promotion is monotonic by construction (`WHERE liveness IS NULL OR liveness = 'process'`).
    // Drive it through a real chatless proxy rather than a direct UPDATE, so the assertion covers the
    // header path too: this proxy sends no CHAT_PROVEN_HEADER, and the promoted row must not move.
    const promoted = [...(await mine()).keys()].filter((id) => livenessOf(id) === "chat");
    expect(promoted, "precondition: the previous test promoted exactly one row").toHaveLength(1);

    const idle = startCodexProxy();
    await idle.initialize();
    expect(livenessOf(promoted[0]), "a chatless request must not demote a promoted row").toBe("chat");
    idle.child.kill();
  }, 30_000);
});

describe("promotion survives a resolve that does not match by tool session id", () => {
  /**
   * `promoteToChat` is called from several resolve sites, and a mutant showed only ONE of them was
   * covered. Deleting the call at the "by seat" site left every suite green, so this test exists to
   * cover it: a proxy whose tool session id has CHANGED still resolves to its live row by seat, and a
   * `tools/call` arriving that way must promote just as one matching by tool session id does.
   *
   * Driven through the hub directly rather than through a proxy, because the proxy mints one tool
   * session id per process — reproducing a changed id needs the request built by hand. The headers are
   * the real ones (the proxy's seat, the proof header), so this is the production path, not a fixture.
   *
   * FALSIFIER: delete `promoteToChat(row.id)` from the "by seat" branch in resolveSessionAgent. This
   * test goes red; the adoption-path mutant does not (that call is unreachable by design).
   */
  it("promotes when the request resolves by SEAT rather than by tool session id", async () => {
    const before = (await mine()).size;
    const { agentId: created } = await startAndIdentify();
    expect(livenessOf(created), "a proxy start alone is 'process'").toBe("process");
    const seat = (db.prepare(`SELECT seat_id FROM agents WHERE id = ?`).get(created) as { seat_id: string }).seat_id;

    // DRIVEN OVER /mcp, WHICH IS THE REAL PATH. Two things had to be right, and the first draft got
    // both wrong in a way that proved nothing about this branch:
    //   - the TOOL SESSION ID must match no row, or `liveByToolSession` (the earlier branch) returns
    //     first and the by-seat branch is never reached;
    //   - it must go over /mcp, because `/v1/sessions/join` passes headers through `sessionFieldsFrom`,
    //     a hand-maintained allowlist that does NOT list `x-opencadre-chat-proven` (src/rest.ts:877).
    //     `/mcp` passes `req.headers` straight to checkDeviceSession (src/mcp.ts:122), which is what
    //     the proxy actually does. A test over join would fail here for a header-plumbing reason and
    //     say nothing about promotion.
    const rpc = (body: unknown) =>
      fetch(`${hub.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${computerCredential(home)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-opencadre-session": `codex-${Date.now().toString(16).padStart(12, "0")}-aaaa-bbbb-cccc`,
          "x-opencadre-host-session": seat,
          "x-opencadre-client": "codex",
          "x-opencadre-project": "local:liveness-proj",
          "x-opencadre-chat-proven": "1",
        },
        body: JSON.stringify(body),
      });

    await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_active_agents" } });

    expect(livenessOf(created), "a tool call resolving by seat promotes, like one by tool session id").toBe("chat");
    expect((await mine()).size, "and it mints no second row").toBe(before + 1);
  }, 30_000);
});
