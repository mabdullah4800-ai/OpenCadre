import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { READ_ONLY_CODE } from "../src/billing.js";
import { normalizeProject } from "../scripts/opencadre-config.mjs";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// A lapsed bill must never block the customer's OWN tools (#416 §8 item 6). When the hub answers 402
// (TRIAL_EXPIRED / PLAN_LIMIT) the client-side hooks and the MCP proxy have to degrade to a NO-OP:
// no approval-gate deny, no stuck Stop hook, no wedged MCP server.
//
// WHY A STUB HUB RATHER THAN A REAL LAPSED WORKSPACE: the subject here is the CLIENT's reaction to a
// status code, not the hub's decision to send it (src/billing.ts already owns that, with its own
// tests). A stub that returns bit-for-bit the body `readOnlyRefusal` builds exercises exactly the
// contract the client reads, and it cannot drift from the real shape without this file failing: the
// body below is assembled from the same constant the hub uses.
//
// The failure this pins, measured at fae9577: an unrecognised 402 falls through every client's
// handling and becomes a thrown `HTTP 402`. For the Stop hook that is a NON-ZERO EXIT on a hook the
// harness expects to be silent, which is the "stuck Stop hook" in the item.

const ROOT = process.cwd();
const HOOKS = {
  awareness: path.join(ROOT, "examples", "hooks", "opencadre-awareness.mjs"),
  gate: path.join(ROOT, "examples", "hooks", "opencadre-approval-gate.mjs"),
  wake: path.join(ROOT, "scripts", "opencadre-wake.mjs"),
  mcp: path.join(ROOT, "scripts", "opencadre-mcp.mjs"),
};

/** Exactly the body src/billing.ts's readOnlyRefusal returns for a lapsed workspace. */
const lapsedBody = () => ({
  error: "This workspace's trial ended on 2026-09-01. Ask an operator to put it on a plan.",
  code: READ_ONLY_CODE,
  plan: "trial",
  trialEndsAt: "2026-09-01T00:00:00.000Z",
  subscriptionStatus: "active",
  readOnly: true,
});

/** A hub that answers the given status/body to EVERY request, so whichever call the client makes
 * first is the one that meets the 402. */
async function stubHub(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())), hits: () => hits };
}

type Run = { code: number | null; out: string; err: string };

function runScript(script: string, args: string[], env: Record<string, string>, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const home = mkdtempSync(path.join(tmpdir(), "b402-home-"));
    // No ambient session ids: this suite may run inside a Claude Code chat, and an inherited id
    // would change which identity path the hook takes.
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "", OPENCADRE_HOOK_HOME: home, ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(input ?? "");
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** A home holding a NAMED-AGENT config pointing at `hub`, which is the simplest way to get every
 * client to talk to a URL this test controls. */
function namedHome(hub: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "b402-named-"));
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { opencadre: { type: "http", url: `${hub}/mcp`, headers: { Authorization: "Bearer agt_" + "0".repeat(48) } } } }),
  );
  return home;
}

/** Seed the gate's clearance-policy cache with `mode`, so the machine looks like one that has run a
 * clearance check before and the hub has gone down since.
 *
 * THE KEY MATTERS AND IS NOT JUST THE URL: the gate builds it as `${base} ${projectKey()}` where
 * projectKey is the normalised git remote of origin, so a cache seeded under any other spelling is
 * simply an EMPTY cache -- and an empty cache falls back to "off", which passes this test whether or
 * not the gate handles 402. Seeding the exact key is what makes the assertion about the 402 and not
 * about the default. */
function seedGateCache(home: string, hub: string, mode: string): void {
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  const project = normalizeProject(execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" })) ?? "";
  writeFileSync(
    path.join(home, ".opencadre", "clearance-policy-cache.json"),
    JSON.stringify({ [`${hub} ${project}`]: { mode, at: new Date().toISOString() } }, null, 2),
  );
}

const gatePayload = () =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: ROOT, tool_name: "Bash", tool_input: { command: "git push --force" } });

describe("a lapsed workspace (402) must not block the customer's own tools", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  // THE CASE THE ITEM IS ABOUT, and the one that fails at fae9577. The gate denies on 401/403 and
  // otherwise `return cached()` -- so a 402 is treated as "the hub is unreachable" and the LAST
  // KNOWN clearance policy is applied. On a machine whose cached mode is `strict`, a lapsed
  // subscription therefore blocks the user's own git push. The bill is not the hub being unreachable,
  // and it is not a reason to hold a command the operator already decided how to handle.
  it("the approval gate does NOT apply a cached strict policy on 402", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = namedHome(hub.url);
    seedGateCache(home, hub.url, "strict");
    const r = await runScript(HOOKS.gate, ["--client", "claude-code"], { OPENCADRE_HOOK_HOME: home }, gatePayload());
    await hub.close();
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    const said = r.out.trim();
    if (said) {
      const parsed = JSON.parse(said) as { hookSpecificOutput?: { permissionDecision?: string }; decision?: string };
      // Whatever it says, it must not be a DENY: a lapsed bill is never grounds to block the user's
      // own tool, which is the whole of #416 §8 item 6.
      expect(parsed.hookSpecificOutput?.permissionDecision, `gate said: ${said}`).not.toBe("deny");
      expect(parsed.decision, `gate said: ${said}`).not.toBe("deny");
    }
  });

  // The Stop hook is the other half: the harness runs it at every turn end, so a non-zero exit or
  // emitted hook JSON on a lapsed workspace is the "stuck Stop hook" from the item.
  it("awareness exits 0 and says nothing on Stop when the hub answers 402", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = namedHome(hub.url);
    const r = await runScript(HOOKS.awareness, ["--client", "claude-code"], { OPENCADRE_HOOK_HOME: home }, JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: ROOT }));
    await hub.close();
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  it("wake does not hold the session open on 402", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = namedHome(hub.url);
    // --rewake is the Stop-hook path: it must end, not block waiting for a hub that will keep refusing.
    const r = await runScript(HOOKS.wake, ["--rewake", "--client", "claude-code"], { OPENCADRE_HOOK_HOME: home }, JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: ROOT }));
    await hub.close();
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(r.out.trim()).toBe("");
  });
});

// The MCP proxy is the third client in the item. Its requirement is different from the hooks': it must
// not DATE-CRASH and must keep the session usable, refusing only the calls the hub refused.
describe("the MCP proxy survives a 402", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("answers a tool call with an error and stays alive rather than exiting", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = namedHome(hub.url);
    // initialize, then a tools/call. A proxy that dies on the 402 gives no second answer.
    const frames =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_messages", arguments: {} } }) + "\n";
    const r = await runScript(HOOKS.mcp, ["--client", "claude-code"], { OPENCADRE_HOOK_HOME: home }, frames);
    await hub.close();
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    const replies = r.out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { id?: number; jsonrpc?: string; result?: unknown; error?: { message?: string } });
    // Every reply must be well-formed JSON-RPC: a truncated or crashed stream fails here.
    for (const m of replies) expect(m.jsonrpc).toBe("2.0");
    // The call is REFUSED (the hub said 402) -- but refused as a protocol error, not by the process dying.
    const callReply = replies.find((m) => m.id === 2);
    expect(callReply, `no reply to the tool call; got: ${r.out}`).toBeDefined();
    expect(callReply!.error ?? callReply!.result).toBeDefined();
  });
});

// Cursor (LAUNCH-CLIENT-GATE.md §1 row 5 for its own row). A Cursor chat reaches the hub through a COMPUTER
// credential and its own hooks, and a new chat's first hook asks the hub to create its seat, which a lapsed
// workspace refuses with 402. Every Cursor hook must still answer `{}` (Cursor's "no opinion"), never a deny,
// never an identity warning, and never an empty answer Cursor would log as a failed run.
describe("Cursor on a lapsed workspace (402)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  /** A home connected as a computer, with Cursor's stamp installed so its chats use their own seats. */
  function cursorHome(hub: string): string {
    const home = mkdtempSync(path.join(tmpdir(), "b402-cursor-"));
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub, credential: `dev_${"c".repeat(48)}`, deviceId: "d1" } }));
    writeFileSync(path.join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'node "x/opencadre-session-stamp.mjs" --client cursor', matcher: "^MCP:" }] } }));
    return home;
  }
  const cursorPayload = (event: string, extra: object = {}) => JSON.stringify({
    conversation_id: "conv-1", session_id: "conv-1", generation_id: "g", model: "m", hook_event_name: event,
    cursor_version: "2026.09.23-86fc751", workspace_roots: [ROOT], user_email: null, transcript_path: null, ...extra,
  });

  it("sessionStart and stop say `{}` rather than 'could not verify this session's identity'", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = cursorHome(hub.url);
    for (const [event, extra] of [["sessionStart", {}], ["stop", { status: "completed", loop_count: 0 }]] as const) {
      const r = await runScript(HOOKS.awareness, ["--client", "cursor"], { OPENCADRE_HOOK_HOME: home }, cursorPayload(event, extra));
      expect(r.code, `stderr: ${r.err}`).toBe(0);
      expect(JSON.parse(r.out), `${event} said: ${r.out}`).toEqual({});
    }
    await hub.close();
  });

  it("the gate never denies a Cursor command because the bill lapsed, even with a cached strict policy", async () => {
    const hub = await stubHub(402, lapsedBody());
    const home = cursorHome(hub.url);
    seedGateCache(home, hub.url, "strict");
    const r = await runScript(HOOKS.gate, ["--client", "cursor"], { OPENCADRE_HOOK_HOME: home }, cursorPayload("beforeShellExecution", { command: "git push --force", cwd: ROOT }));
    await hub.close();
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(JSON.parse(r.out).permission, `gate said: ${r.out}`).not.toBe("deny");
  });
});
