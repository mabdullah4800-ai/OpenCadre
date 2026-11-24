import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { resolveHub } from "../scripts/opencadre-config.mjs";
import { listEvents } from "../src/events.js";
import { createOrganization, getMessages, listActiveAgents, registerAgent, sendMessage } from "../src/service.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// Every test here starts the hook as a child process, so every describe uses the spawn timeout.

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-antigravity.mjs");
// G1: the same expression the hook uses, so this test asserts the path the hook actually computes.
// In a checkout that is scripts/opencadre-wake.mjs; installHelpers rewrites it to ./opencadre-wake.mjs
// when it copies the hook into ~/.opencadre/bin.
const WAKE_SCRIPT = path.join(process.cwd(), "scripts", "opencadre-wake.mjs");

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function runHook(mode: string, env: Record<string, string>, stdin: Record<string, unknown> = {}): Promise<{ code: number | null; out: unknown }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, mode], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: JSON.parse(out) }));
    child.stdin.end(JSON.stringify({ conversationId: "c1", workspacePaths: [process.cwd()], ...stdin }));
  });
}

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const me = registerAgent(orgId, "Antigravity-Me");
  const other = registerAgent(orgId, "Claude-Other");
  const env = {
    OPENCADRE_URL: baseUrl, OPENCADRE_KEY: me.apiKey,
    OPENCADRE_HOOK_STATE_DIR: mkdtempSync(path.join(tmpdir(), "ag-")),
    OPENCADRE_WAKE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "ag-wake-")),
    OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "ag-home-")),
  };
  return { orgId, me: me.agentId, key: me.apiKey, other: { id: other.agentId, name: "Claude-Other" }, env };
}

// The wake watcher's lock (scripts/opencadre-wake.mjs): named by key hash, touched after every poll.
function armWatcher(env: { OPENCADRE_WAKE_STATE_DIR: string }, key: string, { pid = process.pid, ageMs = 0 } = {}) {
  const file = path.join(env.OPENCADRE_WAKE_STATE_DIR, `wake-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`);
  writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now() - ageMs }));
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
}

const injected = (out: unknown) => ((out as { injectSteps?: { ephemeralMessage: string }[] }).injectSteps ?? []).map((s) => s.ephemeralMessage).join("\n");

const stopInput = { executionNum: 1, terminationReason: "model_stop", error: "", fullyIdle: true };

describe("Antigravity Stop hook", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("allows the stop when the inbox is empty", async () => {
    const { env } = setup("AG Stop Quiet Org");
    expect(await runHook("stop", env, stopInput)).toEqual({ code: 0, out: {} });
  });

  it("forces continuation with the pending messages, without marking them read", async () => {
    const { orgId, me, other, env } = setup("AG Stop Mail Org");
    await sendMessage(orgId, other, "Antigravity-Me", "ping, reply please", "high");
    const { code, out } = await runHook("stop", env, stopInput);
    expect(code).toBe(0);
    const { decision, reason } = out as { decision: string; reason: string };
    expect(decision).toBe("continue");
    expect(reason).toContain("Claude-Other");
    expect(reason).toContain("ping, reply please");
    expect(reason).toContain("get_messages");
    // Peek only: the agent must still find the message when it reads its inbox.
    expect(getMessages(orgId, me, undefined, { peek: true })).toHaveLength(1);
  });

  it("keeps the continue reason short: capped previews, full bodies stay in get_messages", async () => {
    const { orgId, other, env } = setup("AG Stop Preview Org");
    for (let i = 0; i < 7; i++) await sendMessage(orgId, other, "Antigravity-Me", `msg${i} ${"x".repeat(1000)}`, "low");
    const { reason } = (await runHook("stop", env, stopInput)).out as { reason: string };
    expect(reason).toContain("7 unread");
    expect(reason).toContain("and 2 more");
    expect(reason.length).toBeLessThan(1200);
  });

  it("gives up after repeated continues on the same unread mail, so it can never loop forever", async () => {
    const { orgId, other, env } = setup("AG Stop Loop Org");
    await sendMessage(orgId, other, "Antigravity-Me", "stuck?", "medium");
    expect((await runHook("stop", env, stopInput)).out).toHaveProperty("decision", "continue");
    expect((await runHook("stop", env, stopInput)).out).toHaveProperty("decision", "continue");
    expect((await runHook("stop", env, stopInput)).out).toEqual({});
  });

  it("does not hijack a stop caused by an error", async () => {
    const { orgId, other, env } = setup("AG Stop Error Org");
    await sendMessage(orgId, other, "Antigravity-Me", "hello", "medium");
    expect((await runHook("stop", env, { ...stopInput, error: "quota exceeded" })).out).toEqual({});
  });

  it("allows the stop when the hub is unreachable or unconfigured", async () => {
    const { env } = setup("AG Stop Down Org");
    expect((await runHook("stop", { ...env, OPENCADRE_URL: "http://127.0.0.1:1" }, stopInput)).out).toEqual({});
    expect((await runHook("stop", { ...env, OPENCADRE_KEY: "" }, stopInput)).out).toEqual({});
  });
});

describe("Antigravity PreInvocation hook", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("injects nothing once the conversation knows who it is and the watcher is armed", async () => {
    const { env, key } = setup("AG Pre Quiet Org");
    armWatcher(env, key);
    await runHook("pre-invocation", env, { invocationNum: 1 });
    expect(await runHook("pre-invocation", env, { invocationNum: 2 })).toEqual({ code: 0, out: {} });
  });

  // A usage-limit model switch or a new chat starts a conversation that remembers nothing,
  // so every new conversationId is told its fleet identity and protocol again.
  it("re-onboards every new conversation with identity and protocol, once per conversation", async () => {
    const { env, key } = setup("AG Pre Identity Org");
    armWatcher(env, key);
    const first = injected((await runHook("pre-invocation", env, { conversationId: "c-old", invocationNum: 1 })).out);
    expect(first).toContain("You are Antigravity-Me");
    expect(first).toContain("Never put a key");
    expect(injected((await runHook("pre-invocation", env, { conversationId: "c-old", invocationNum: 2 })).out)).not.toContain("You are");
    const switched = injected((await runHook("pre-invocation", env, { conversationId: "c-new-model", invocationNum: 1 })).out);
    expect(switched).toContain("You are Antigravity-Me");
  });

  it("tells the model to relaunch the wake watcher when none is running, at most every 5 minutes", async () => {
    const { env } = setup("AG Pre Watcher Org");
    const out = injected((await runHook("pre-invocation", env, { conversationId: "c1", invocationNum: 1 })).out);
    expect(out).toContain("wake watcher is NOT running");
    expect(out).toContain(`node "${WAKE_SCRIPT}"`);
    expect(injected((await runHook("pre-invocation", env, { conversationId: "c1", invocationNum: 2 })).out)).not.toContain("NOT running");
  });

  // G1. The hook must name a watcher path that exists where the hook is RUNNING, not where it was
  // written. The repo checkout and the installed copy in ~/.opencadre/bin are different folders, so a
  // repo-relative path in the injected text only ever worked for this repository's own demo. The
  // installed copy is produced by installHelpers, which rewrites ../../scripts/ to ./ as it copies,
  // so deriving the path from the hook's own location is correct in both places.
  it("names the wake script by its own location, so the installed copy points at the installed watcher", async () => {
    const { env, key } = setup("AG Pre Wake Path Org");
    armWatcher(env, key);
    const identity = injected((await runHook("pre-invocation", env, { conversationId: "c-wake", invocationNum: 1 })).out);
    const nudge = injected((await runHook("pre-invocation", { ...env, OPENCADRE_HOOK_STATE_DIR: mkdtempSync(path.join(tmpdir(), "ag-w2-")) }, { conversationId: "c-wake2", invocationNum: 1 })).out);
    for (const text of [identity, nudge]) expect(text).toContain(WAKE_SCRIPT);
    // Repo-relative would be wrong everywhere except this checkout's own root.
    expect(identity).not.toContain("node scripts/opencadre-wake.mjs");
    expect(nudge).not.toContain("node scripts/opencadre-wake.mjs");
  });

  // G2, hook half. The protocol pointed at .agent/rules/opencadre-inbox.md, a file that exists only
  // inside this repository - a customer workspace never has it. The rule now ships from connect.
  it("points at the rule connect installs, not at a repo-only path", async () => {
    const { env, key } = setup("AG Pre Rule Path Org");
    armWatcher(env, key);
    const out = injected((await runHook("pre-invocation", env, { conversationId: "c-rule", invocationNum: 1 })).out);
    expect(out).toContain("GEMINI.md");
    expect(out).not.toContain(".agent/rules/");
  });

  it("treats a stale or dead watcher lock as not running", async () => {
    const { env, key } = setup("AG Pre Stale Org");
    armWatcher(env, key, { ageMs: 10 * 60_000 });
    expect(injected((await runHook("pre-invocation", env, { conversationId: "c-stale", invocationNum: 1 })).out)).toContain("NOT running");
    const other = setup("AG Pre Dead Org");
    armWatcher(other.env, other.key, { pid: 2 ** 22 + 12345 });
    expect(injected((await runHook("pre-invocation", other.env, { conversationId: "c-dead", invocationNum: 1 })).out)).toContain("NOT running");
  });

  it("injects the awareness digest as an ephemeral message", async () => {
    const { orgId, other, env, key } = setup("AG Pre Digest Org");
    armWatcher(env, key);
    await runHook("pre-invocation", env, { invocationNum: 1 });
    await sendMessage(orgId, other, "Antigravity-Me", "prod is down", "high");
    const { out } = await runHook("pre-invocation", env, { invocationNum: 2 });
    const steps = (out as { injectSteps: { ephemeralMessage: string }[] }).injectSteps;
    expect(steps).toHaveLength(1);
    expect(steps[0].ephemeralMessage).toContain("[P1]");
    expect(steps[0].ephemeralMessage).toContain("Claude-Other");
  });

  // G3. Commands run from the folder holding hooks.json. For the global install connect writes, that
  // is ~/.gemini/config - no git checkout - so process.cwd() resolved every workspace to
  // local:config. The workspace is in the payload, so the hook must pass it to the resolver.
  //
  // The project header only exists on the device-credential path: a named agent returns no headers at
  // all (scripts/opencadre-config.mjs), so the assertion is made against resolveHub directly with a
  // device credential rather than through a hook run with an agt_ key.
  it("names the project from the payload's workspace, not from the hook's own working folder", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ag-home-proj-"));
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".opencadre", "credentials.json"),
      JSON.stringify({ devices: { antigravity: { hub: "http://dev-hub/", credential: `dev_${"ab".repeat(24)}`, deviceId: "d1" } } }));
    const workspace = mkdtempSync(path.join(tmpdir(), "ag-ws-"));
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    const headersFor = (cwd?: string) => resolveHub({ client: "antigravity", cwd, home, env: {}, sessionId: "sess-1" }).headers ?? {};
    // mkdtemp gives the folder a mixed-case suffix, and projectIdentity lowercases a `local:` key on
    // purpose (scripts/opencadre-config.mjs) so one folder reached as `Desktop\OpenCadre` and as
    // `desktop\opencadre` stays one project. Expect the lowercased key on both sides: spelling the
    // expectation the folder's own way would make the negative assertion below pass vacuously.
    const workspaceKey = `local:${path.basename(workspace).toLowerCase()}`;
    // The payload's workspace names its own project...
    expect(headersFor(workspace)["x-opencadre-project"]).toBe(workspaceKey);
    // ...while the hook's own folder names a different one, which is the bug this guards. The hook's
    // folder is the repo checkout under test here; the point is that the two disagree.
    expect(headersFor(undefined)["x-opencadre-project"]).not.toBe(workspaceKey);
  });
});

describe("Antigravity usage limits", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const usageOf = (orgId: string, agentId: string) => listActiveAgents(orgId).find((a) => a.id === agentId)!.usage;

  it("reports out of usage when a stop is caused by a quota error, and restored once it runs again", async () => {
    const { orgId, me, env, key } = setup("AG Usage Org");
    armWatcher(env, key);
    const stopped = await runHook("stop", env, { ...stopInput, terminationReason: "error", error: "RESOURCE_EXHAUSTED: 5-hour Usage Limit reached" });
    expect(stopped).toEqual({ code: 0, out: {} });
    expect(usageOf(orgId, me)).toMatchObject({ limited: true, resetsAt: null, usedPct: null, source: "antigravity" });

    await runHook("pre-invocation", env, { invocationNum: 1 });
    const restored = usageOf(orgId, me)!;
    expect(restored).toMatchObject({ limited: false, source: "antigravity" });
    expect(listEvents(orgId, { types: ["agent.usage_limited", "agent.usage_restored"] }).map((e) => e.type))
      .toEqual(["agent.usage_limited", "agent.usage_restored"]);

    // Only the first invocation after a limit reports; ordinary turns post nothing.
    await runHook("pre-invocation", env, { invocationNum: 2 });
    expect(usageOf(orgId, me)).toEqual(restored);
  });

  it("matches credit and rate limit errors, and ignores other errors", async () => {
    for (const error of ["Out of credits", "Rate limit exceeded", "quota exceeded"]) {
      const { orgId, me, env } = setup(`AG Usage Match ${error}`);
      await runHook("stop", env, { ...stopInput, error });
      expect(usageOf(orgId, me)?.limited, error).toBe(true);
    }
    const { orgId, me, env } = setup("AG Usage Other Error Org");
    await runHook("stop", env, { ...stopInput, error: "tool call failed: ENOENT" });
    await runHook("pre-invocation", env, { invocationNum: 1 });
    expect(usageOf(orgId, me)).toBeNull();
  });
});
