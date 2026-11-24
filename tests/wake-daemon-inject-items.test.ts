import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexInjectItemsAdapter, SAFE_ID } from "../scripts/wake-daemon/inject-items.mjs";
import { runWakeCycle } from "../scripts/wake-daemon/orchestrator.mjs";
import { initLimiterState } from "../scripts/wake-daemon/rate-limiter.mjs";

const dir = () => mkdtempSync(path.join(tmpdir(), "wake-inject-"));
const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1", body: "prod is down", priority: "high", from_agent_id: "peer", from_agent_name: "Waker", ...over,
});
const digestOf = (ids: string[], line = "[high] from Waker: prod is down") => ({ ids, top: "high" as const, line });
const session = (over: Record<string, unknown> = {}) => ({
  sessionId: "sess-1", threadId: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000", status: "idle" as const, ...over,
});

/** A fake `codex app-server`: a Writable stdin that answers each JSON-RPC request with a result, so
 * the adapter's real protocol dialogue runs without a real process. `calls` accumulates across every
 * child this factory hands out, so a test can assert on the injected items and force an error reply. */
function fakeAppServer({ failInject = false } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const make = () => {
    const child = new EventEmitter() as EventEmitter & { stdin: any; stdout: EventEmitter; stderr: EventEmitter; kill: () => void; killed?: boolean };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.stdin = {
      write(chunk: string) {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          let req: any;
          try { req = JSON.parse(line); } catch { continue; }
          if (req.method === "initialized") continue; // a notification, no reply
          calls.push({ method: req.method, params: req.params });
          setTimeout(() => {
            if (child.killed) return;
            const reply = req.method === "thread/inject_items" && failInject
              ? { id: req.id, error: { code: -32602, message: "no such thread" } }
              : { id: req.id, result: {} };
            child.stdout.emit("data", JSON.stringify(reply) + "\n");
          }, 0);
        }
        return true;
      },
    };
    return child;
  };
  return { make, calls };
}

function spawnFactory(server: { child: any }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  // A FRESH child per spawn: a real app-server is a new process each time, and reusing one would
  // carry `killed` across calls so the second wake's replies would be silently dropped.
  const fn: any = (command: string, args: string[]) => {
    calls.push({ command, args });
    return server.make();
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------------------------
// canWake: injection is only possible when we know WHICH thread to inject into.
// ---------------------------------------------------------------------------------------------

describe("inject_items adapter: canWake", () => {
  it("is wakeable when the session names a Codex thread", async () => {
    const a = codexInjectItemsAdapter({ stateDir: dir() });
    expect(await a.canWake(session(), digestOf(["m1"]))).toEqual({ ok: true });
  });

  it("reports no-owner when there is no thread id, so the orchestrator fails over instead of retrying", async () => {
    const a = codexInjectItemsAdapter({ stateDir: dir() });
    expect(await a.canWake(session({ threadId: undefined }), digestOf(["m1"]))).toEqual({ ok: false, reason: "no-owner" });
  });

  it("reports no-owner rather than injecting into a path-unsafe thread id", async () => {
    const a = codexInjectItemsAdapter({ stateDir: dir() });
    // Same guard the lease file uses: a value that could escape a directory is not an id.
    expect(await a.canWake(session({ threadId: "../../etc/passwd" }), digestOf(["m1"]))).toEqual({ ok: false, reason: "no-owner" });
    expect(await a.canWake(session({ threadId: ".." }), digestOf(["m1"]))).toEqual({ ok: false, reason: "no-owner" });
    expect(SAFE_ID.test("../../etc/passwd")).toBe(false);
    expect(SAFE_ID.test("0199aaaa-bbbb-cccc-dddd-eeeeffff0000")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// detect: a real check, unlike the T3 adapters' hardcoded `true`.
// ---------------------------------------------------------------------------------------------

describe("inject_items adapter: detect", () => {
  it("is undetectable when the Codex CLI cannot be resolved", async () => {
    const a = codexInjectItemsAdapter({ stateDir: dir(), probe: () => false });
    expect(await a.detect()).toBe(false);
  });

  it("is detectable when the CLI resolves, and a throwing probe is a false, not a crash", async () => {
    expect(await codexInjectItemsAdapter({ stateDir: dir(), probe: () => true }).detect()).toBe(true);
    const throwing = codexInjectItemsAdapter({ stateDir: dir(), probe: () => { throw new Error("boom"); } });
    expect(await throwing.detect()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// wake: the protocol dialogue, and the two ways it must decline rather than lie.
// ---------------------------------------------------------------------------------------------

describe("inject_items adapter: wake", () => {
  it("sends the digest as ONE injected user item, and starts no turn", async () => {
    const server = fakeAppServer();
    const spawnFn = spawnFactory(server);
    const a = codexInjectItemsAdapter({ stateDir: dir(), spawnFn });

    const r = await a.wake(session(), digestOf(["m1"], "[high] from Waker: prod is down"));

    expect(r).toEqual({ attempted: true, detail: "item injected (no turn started)" });
    // Resume FIRST, then inject: a fresh app-server has no thread loaded, and an inject into one it
    // has never seen is refused with `-32600 thread not found` (measured). This ordering is the fix.
    expect(server.calls.map((c) => c.method)).toEqual(["initialize", "thread/resume", "thread/inject_items"]);
    expect(server.calls.find((c) => c.method === "thread/resume")!.params.threadId).toBe("0199aaaa-bbbb-cccc-dddd-eeeeffff0000");
    const inject = server.calls.find((c) => c.method === "thread/inject_items")!;
    expect(inject.params.threadId).toBe("0199aaaa-bbbb-cccc-dddd-eeeeffff0000");
    expect(inject.params.items).toHaveLength(1);
    expect(inject.params.items[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[high] from Waker: prod is down" }],
    });
    // The one thing this adapter must never do. `thread/resume` is expected and required (it LOADS
    // the thread -- see above); what must never appear is a TURN, which is what the T3 adapter's
    // `codex exec resume` starts and what makes its lock guard load-bearing.
    expect(server.calls.some((c) => /^turn\//.test(c.method))).toBe(false);
  });

  it("declines with attempted:false when the app-server refuses the inject, and never throws", async () => {
    const server = fakeAppServer({ failInject: true });
    const a = codexInjectItemsAdapter({ stateDir: dir(), spawnFn: spawnFactory(server) });

    const r = await a.wake(session(), digestOf(["m1"]));
    expect(r.attempted).toBe(false);
    expect(r.detail).toMatch(/inject failed/);
  });

  it("declines with attempted:false when the CLI cannot be spawned at all", async () => {
    const a = codexInjectItemsAdapter({
      stateDir: dir(),
      spawnFn: (() => { throw new Error("ENOENT"); }) as any,
    });
    const r = await a.wake(session(), digestOf(["m1"]));
    expect(r.attempted).toBe(false);
    expect(r.detail).toMatch(/spawn failed/);
  });

  it("reports verifyMs 0, because a turn-free adapter can never satisfy a did-a-turn-begin check", async () => {
    const a = codexInjectItemsAdapter({ stateDir: dir() });
    expect(a.verifyMs).toBe(0);
    expect(a.idleTokenCost).toBe("zero");
  });
});

// ---------------------------------------------------------------------------------------------
// Idempotence: the key is the message-id set, and this pins it in both directions.
// ---------------------------------------------------------------------------------------------

describe("inject_items adapter: idempotence", () => {
  it("injects the same digest ONCE, and refuses the second delivery", async () => {
    const stateDir = dir();
    const server = fakeAppServer();
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(server) });
    const d = digestOf(["m1", "m2"]);

    expect((await a.wake(session(), d)).attempted).toBe(true);
    const second = await a.wake(session(), d);

    expect(second.attempted).toBe(false);
    expect(second.detail).toMatch(/duplicate/);
    // The instrument that matters: the hub was actually called once, not twice.
    const injects = server.calls.filter((c) => c.method === "thread/inject_items");
    expect(injects).toHaveLength(1);
  });

  it("still injects a DIFFERENT digest -- the control that proves the guard is the id set, not a dead switch", async () => {
    const stateDir = dir();
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()) });
    await a.wake(session(), digestOf(["m1"]));
    const other = await a.wake(session(), digestOf(["m3"]));
    expect(other.attempted).toBe(true);
  });

  it("injects when only SOME ids were delivered before -- partial overlap is new mail, not a duplicate", async () => {
    const stateDir = dir();
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()) });
    await a.wake(session(), digestOf(["m1"]));
    expect((await a.wake(session(), digestOf(["m1", "m2"]))).attempted).toBe(true);
  });

  it("records nothing when the inject FAILED, so a retry is not mistaken for a duplicate", async () => {
    const stateDir = dir();
    const failing = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer({ failInject: true })) });
    expect((await failing.wake(session(), digestOf(["m7"]))).attempted).toBe(false);

    // A later successful attempt with the SAME id must go through.
    const working = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()) });
    expect((await working.wake(session(), digestOf(["m7"]))).attempted).toBe(true);
  });

  it("ages delivered ids out of the window, so the memory cannot grow without bound", async () => {
    const stateDir = dir();
    let clock = 1_000_000;
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()), now: () => clock });
    await a.wake(session(), digestOf(["m1"]));
    clock += 300_001; // past the 300s default window
    const again = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()), now: () => clock });
    expect((await again.wake(session(), digestOf(["m1"]))).attempted).toBe(true);
  });

  it("injects a digest with no ids rather than treating an empty set as an all-seen duplicate", async () => {
    const stateDir = dir();
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()) });
    expect((await a.wake(session(), digestOf([]))).attempted).toBe(true);
  });

  it("writes the memory under the given state dir and keeps the recorded shape stable", async () => {
    const stateDir = dir();
    const a = codexInjectItemsAdapter({ stateDir, spawnFn: spawnFactory(fakeAppServer()), now: () => 1234 });
    await a.wake(session(), digestOf(["m1", "m2"]));
    const file = path.join(stateDir, "opencadre-injected-items.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([
      { id: "m1", at: 1234 },
      { id: "m2", at: 1234 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the real orchestrator: it is chosen first, it fails over when it cannot, and a
// turn-free adapter must not stall the verify gate.
// ---------------------------------------------------------------------------------------------

describe("inject_items adapter: through runWakeCycle", () => {
  it("INJECTS on the cycle (proved at the protocol), even though the turn-based verify gate cannot confirm it", async () => {
    const server = fakeAppServer();
    const injector = codexInjectItemsAdapter({ stateDir: dir(), spawnFn: spawnFactory(server) });

    const r = await runWakeCycle({
      session: session(),
      messages: [msg()],
      adapters: [injector as any],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      now: () => 1000,
      verifyStatus: async () => "idle",
      sleep: async () => {},
    });

    // The delivery HAPPENED: the hub was called with the item. That is the fact this PR ships.
    expect(server.calls.some((c) => c.method === "thread/inject_items")).toBe(true);
    // And the orchestrator does not call it a wake, because its verify asks "did a turn begin?" --
    // the one question a turn-free adapter must never answer yes to. The mismatch is real and is
    // asserted here rather than hidden: this is why verifyMs is 0 and not a small positive number,
    // which would only have added a wait before reaching the same answer.
    expect(r.action).not.toBe("woke");
  });

  it("fails over to the next tier when there is no thread to inject into", async () => {
    const injector = codexInjectItemsAdapter({ stateDir: dir(), spawnFn: spawnFactory(fakeAppServer()) });
    const second = { id: "second", tier: 3 as const, idleTokenCost: "zero" as const, verifyMs: 0, detect: async () => true, canWake: async () => ({ ok: false, reason: "locked" as const }), wake: async () => ({ attempted: true, detail: "n/a" }) };

    const r = await runWakeCycle({
      session: session({ threadId: undefined }),
      messages: [msg()],
      adapters: [injector, second as any],
      leaseDir: dir(),
      limiterState: initLimiterState(),
      now: () => 1000,
      verifyStatus: async () => "idle",
      sleep: async () => {},
    });

    // Neither verified, so the cycle exhausts -- but it must not have reported a false wake.
    expect(r.action).toBe("exhausted");
  });
});
