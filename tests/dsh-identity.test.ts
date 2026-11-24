import { describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { resolveHub, resolveSessionId } from "../scripts/opencadre-config.mjs";
import { CLIENT_NAMES, COMPUTER_TOOLS, MEASURING_CLIENTS, READER_NAMES, sessionIdSourceFor } from "../scripts/opencadre-clients.mjs";

/**
 * Unit 2: a DSH chat gets its OWN OpenCadre identity.
 *
 * THE PROPERTY THAT MATTERS, and the one this file exists for: TWO CHATS MUST BE TWO AGENTS.
 * Before this unit a DSH chat reached the hub with a static agent key and no session header, so
 * every chat on the machine was the same agent to OpenCadre. The failure this must prevent is the
 * opposite mistake - every chat collapsing into one identity - because with a machine-wide
 * credential that means misattributed mail and status across every harness on the box.
 *
 * Written by DeepSeek-D2V6 for unit 2 (#207). The id source is the one open decision and its
 * tests are marked as such below rather than silently assumed.
 */

const noEnv = { OPENCADRE_HOOK_HOME: "" };
const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-dsh-home-"));
const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-dsh-session.mjs");

/** A machine credential, so the device path is reachable without a named agent. */
function homeWithDevice() {
  const home = tempHome();
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(
    path.join(home, ".opencadre", "credentials.json"),
    JSON.stringify({
      computer: { hub: "http://hub.example/", credential: `dev_${"ab".repeat(24)}`, deviceId: "d1" },
    }),
  );
  return home;
}

const sessionOf = (hub: { headers?: Record<string, string> }) => hub.headers?.["x-opencadre-session"];

describe("unit 2: the hook works under the environment DSH actually provides", () => {
  /**
   * THE DIVERGENCE THIS CLOSES. Every other test here sets OPENCADRE_HOOK_HOME to a temp home -
   * including the subprocess tests - so the suite exercises a path PRODUCTION NEVER TAKES. DSH
   * passes only { CLAUDE_PROJECT_DIR } plus a cwd (found by DeepSeek-SuperVisor against a real
   * recorder), so in production OPENCADRE_HOOK_HOME is absent and the home comes from
   * os.homedir() instead.
   *
   * That is the same class as the defect it was meant to catch: a test environment that differs
   * from production in exactly the way that matters. These assertions run WITHOUT the variable,
   * exactly as the real hook runs, and never read the credential - only that resolution succeeds
   * and carries a distinct session per chat.
   */
  const realHookEnv = () => ({ CLAUDE_PROJECT_DIR: process.cwd(), PATH: process.env.PATH ?? "" });

  it("resolves as CLIENT dsh with no OPENCADRE_HOOK_HOME set", () => {
    const hub = resolveHub({ client: "dsh", env: realHookEnv(), sessionId: "real-env-1", cwd: process.cwd() });
    // Whether a credential exists on this machine is not this test's business - what it asserts
    // is that the ABSENCE of OPENCADRE_HOOK_HOME does not, by itself, break resolution.
    if (!hub.key) {
      // No machine credential here: the hook must still refuse cleanly rather than resolve a
      // shared identity. That is the fail-closed contract, asserted under the real env.
      expect(hub).toEqual({});
      return;
    }
    expect(sessionOf(hub)).toBe("real-env-1");
    expect(hub.headers?.["x-opencadre-client"]).toBe("dsh");
  });

  it("reaches the SAME credential as it would with OPENCADRE_HOOK_HOME pointing at the real home", () => {
    // The homedir() fallback must land where an explicit real-home value would. Comparing the two
    // is what proves the fallback is not silently resolving somewhere else.
    const implicit = resolveHub({ client: "dsh", env: realHookEnv(), sessionId: "s", cwd: process.cwd() });
    const explicit = resolveHub({
      client: "dsh",
      env: { ...realHookEnv(), OPENCADRE_HOOK_HOME: homedir() },
      sessionId: "s",
      cwd: process.cwd(),
    });
    expect(explicit.base).toBe(implicit.base);
    expect(Boolean(explicit.key)).toBe(Boolean(implicit.key));
  });

  it("two chats under the REAL env still get distinct identities", () => {
    const a = resolveHub({ client: "dsh", env: realHookEnv(), sessionId: "real-A", cwd: process.cwd() });
    const b = resolveHub({ client: "dsh", env: realHookEnv(), sessionId: "real-B", cwd: process.cwd() });
    if (!a.key) {
      expect(b).toEqual({});
      return;
    }
    expect(sessionOf(a)).not.toBe(sessionOf(b));
  });

  it("the hook process itself exits cleanly under the real env, with stdin left OPEN", async () => {
    // Combines both production conditions in one run: the DSH env (no OPENCADRE_HOOK_HOME) and
    // stdin never closed. Either one alone has hidden a defect already today.
    const exited = await new Promise<boolean>((resolve) => {
      const child = spawn(process.execPath, [HOOK], { env: realHookEnv(), cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write(JSON.stringify({ session_id: "real-hook-1", cwd: process.cwd(), hook_event_name: "SessionStart" }));
      // deliberately NOT closing stdin
      const watchdog = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5_000);
      child.on("close", () => {
        clearTimeout(watchdog);
        resolve(true);
      });
    });
    expect(exited, "the hook must exit under the real env even with stdin open").toBe(true);
  }, 20_000);
});

describe("unit 2: the dsh row in the canonical table", () => {
  it("declares dsh as a served client with NO id source, deliberately", () => {
    expect(CLIENT_NAMES).toContain("dsh");
    expect(COMPUTER_TOOLS).toContain("dsh");
    expect(MEASURING_CLIENTS).not.toContain("dsh");
    // dsh has no config-file reader: it is served by a hook, not by reading a tool's config.
    expect(READER_NAMES).not.toContain("dsh");
    // AND NO sessionIdSource, unlike every other served client. This is not an omission: the hook
    // supplies the id per event, and resolveSessionId honours a caller-supplied id BEFORE any
    // declaration. A declaration here would name a channel the consumer can never read - measured:
    // DSH_SESSION_ID is never in the host env, and is injected only into shell-tool children.
    expect(sessionIdSourceFor("dsh")).toBeUndefined();
  });

  it("a declaration would be unsatisfiable, which is WHY there is none", () => {
    // The claim the row rests on, asserted rather than described: the env route DSH would have
    // declared cannot resolve, while the hook's supplied id needs no declaration at all.
    const childEnv = { PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "cc-survives" };
    const viaDeclaration = resolveSessionId({ source: { from: "env", name: "DSH_SESSION_ID" }, env: childEnv });
    expect(viaDeclaration.ok).toBe(false);
    expect(viaDeclaration.reason).toBe("absent");

    const viaCaller = resolveSessionId({ sessionId: "session-from-hook-payload", env: childEnv });
    expect(viaCaller).toEqual({ ok: true, id: "session-from-hook-payload" });
  });

  it("does not disturb any other client's declaration", () => {
    // Adding a client must not silently change an existing one's identity source.
    expect(sessionIdSourceFor("claude-code")).toEqual({
      from: "env",
      name: "CLAUDE_CODE_SESSION_ID",
      keeper: "CLAUDE_CODE_HOST_SESSION_ID",
    });
    expect(sessionIdSourceFor("codex")).toEqual({ from: "process", name: "codex" });
    expect(sessionIdSourceFor("cursor")).toEqual({ from: "stamp", name: "cursor" });
    expect(sessionIdSourceFor("gemini")).toEqual({ from: "stamp", name: "gemini" });
    // Measuring clients still declare nothing.
    expect(sessionIdSourceFor("grok")).toEqual({ from: "env", name: "GROK_SESSION_ID" });
    expect(sessionIdSourceFor("antigravity")).toEqual({ from: "stamp", name: "antigravity" });
  });
});

describe("unit 2: two chats are two agents", () => {
  it("a different session id yields a different x-opencadre-session header", () => {
    const home = homeWithDevice();
    const a = resolveHub({ client: "dsh", home, env: noEnv, sessionId: "session-chat-A", cwd: home });
    const b = resolveHub({ client: "dsh", home, env: noEnv, sessionId: "session-chat-B", cwd: home });
    expect(sessionOf(a)).toBe("session-chat-A");
    expect(sessionOf(b)).toBe("session-chat-B");
    expect(sessionOf(a)).not.toBe(sessionOf(b));
    // Same credential, different sessions: the credential identifies the MACHINE, the header the chat.
    expect(a.key).toBe(b.key);
  });

  it("does NOT resolve from $env:DSH_SESSION_ID - the row declares no source, on purpose", () => {
    // THIS TEST REPLACES ONE THAT ASSERTED THE OPPOSITE, and the replacement is the point.
    //
    // The earlier version asserted that a dsh resolve reads DSH_SESSION_ID from the environment.
    // That could never happen in production, and the row no longer declares it: DSH never puts the
    // id in its own process env, and DSH_* is not inherited by children (the only assignment lives
    // in dsh-shell-env, set per SHELL call). So the old assertion described a route that provably
    // never runs - a test certifying an identity path that does not exist.
    const home = homeWithDevice();
    const hub = resolveHub({ client: "dsh", home, env: { ...noEnv, DSH_SESSION_ID: "session-from-env" }, cwd: home });
    expect(hub).toEqual({});
    expect(sessionOf(hub)).toBeUndefined();
  });

  it("REFUSES rather than substituting when there is no session id", () => {
    // The load-bearing negative. A defaulted or shared id here would make every chat one agent.
    const home = homeWithDevice();
    const hub = resolveHub({ client: "dsh", home, env: noEnv, cwd: home });
    expect(hub).toEqual({});
    expect(sessionOf(hub)).toBeUndefined();
  });

  it("refuses a malformed id too, rather than repairing it into another chat's identity", () => {
    const home = homeWithDevice();
    expect(resolveHub({ client: "dsh", home, env: noEnv, sessionId: "has space", cwd: home })).toEqual({});
    expect(resolveHub({ client: "dsh", home, env: noEnv, sessionId: "   ", cwd: home })).toEqual({});
  });
});

describe("unit 2: nothing leaks into other clients", () => {
  it("a dsh session id does not affect a claude-code resolve", () => {
    const home = homeWithDevice();
    // A caller-supplied id is honoured ONLY for the client it was supplied for; the loop in
    // resolveHub can walk more than one candidate name, so leaking one client's id onto another
    // is the misattribution this area exists to prevent.
    const env = { ...noEnv, DSH_SESSION_ID: "session-dsh-only" };
    // claude-code reads CLAUDE_CODE_SESSION_ID, which is absent here, so it must refuse - even
    // with a DSH id sitting in the environment.
    expect(resolveHub({ client: "claude-code", home, env, cwd: home })).toEqual({});
    // dsh with the same env also refuses, because the environment is not its route either: the
    // hook supplies the id. Same env, two clients, both honest about having no per-chat identity.
    expect(resolveHub({ client: "dsh", home, env, cwd: home })).toEqual({});
    // And the per-chat identity DOES work when the caller supplies it, which is the hook's path.
    expect(sessionOf(resolveHub({ client: "dsh", home, env, sessionId: "from-hook", cwd: home }))).toBe("from-hook");
  });

  it("a codex process id is not reused for dsh", () => {
    const home = homeWithDevice();
    const codex = resolveHub({ client: "codex", home, env: noEnv, cwd: home });
    // codex synthesizes per process; dsh must not inherit that id.
    expect(sessionOf(codex)).toMatch(/^codex-/);
    expect(resolveHub({ client: "dsh", home, env: noEnv, cwd: home })).toEqual({});
  });
});

describe("unit 2: the hook", () => {
  /**
   * Runs the hook against a REAL local hub and returns what that hub received.
   *
   * Asserting only the exit code would be a vacuous check - the hook exits 0 whether or not it
   * sends anything, which is deliberate (a hook must never fail the chat it runs inside). So the
   * test watches the wire instead: this is the assertion that would catch a hook that resolves an
   * identity and then forgets to forward it, which is exactly the "wired at one end" defect class.
   */
  const runHookAgainstHub = (payload: unknown, opts: { closeStdin?: boolean; timeoutMs?: number } = {}) =>
    new Promise<{
      code: number | null;
      seen: { url?: string; sess?: string; client?: string } | null;
      requests: number;
      exited: boolean;
    }>((resolve) => {
      const { closeStdin = true, timeoutMs = 5_000 } = opts;
      const home = homeWithDevice();
      let seen: { url?: string; sess?: string; client?: string } | null = null;
      let requests = 0;
      let settled = false;
      const settle = (exited: boolean, code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        server.close();
        resolve({ code, seen, requests, exited });
      };
      // If the hook hangs on stdin the process never closes; the watchdog reports that as
      // exited:false rather than letting the test suite itself hang.
      let watchdog: NodeJS.Timeout = setTimeout(() => settle(false, null), timeoutMs);
      const server = http.createServer((req, res) => {
        requests++;
        seen = {
          url: req.url,
          sess: req.headers["x-opencadre-session"] as string | undefined,
          client: req.headers["x-opencadre-client"] as string | undefined,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
        server.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          // The hook reads the hub from the credential file, so point that at this server.
          writeFileSync(
            path.join(home, ".opencadre", "credentials.json"),
            JSON.stringify({
              computer: { hub: `http://127.0.0.1:${port}/`, credential: `dev_${"ab".repeat(24)}`, deviceId: "d1" },
            }),
          );
          const child = spawn(process.execPath, [HOOK], {
            env: { ...process.env, OPENCADRE_HOOK_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stdin.write(JSON.stringify(payload));
          // THE CASE THAT MATTERS: DSH NEVER CLOSES A HOOK'S STDIN. With closeStdin false the pipe
          // stays open after the payload, which is what the real harness does - and a hook that
          // waits for end-of-input never exits, leaking a process per invocation.
          if (closeStdin) child.stdin.end();
          child.on("close", (code) => {
            settle(true, code);
          });
        });
      },
    );

  it("EXITS WHEN STDIN IS NEVER CLOSED (DSH does not close a hook's stdin)", async () => {
    // THE DEFECT THIS EXISTS FOR, found by DeepSeek-SuperVisor against a recorder he wired up:
    // DSH does not close a hook's stdin, so a hook that reads with `for await (const chunk of
    // process.stdin)` - the obvious form - waits for an `end` that never comes, never exits, and
    // leaks one process per invocation for the life of the session.
    //
    // IT IS INVISIBLE IN A TEST HARNESS, because a harness closes stdin. That is why the first
    // version of this file passed while carrying the bug: my helper wrote the payload AND ended
    // the pipe, so the hang never occurred. The fix is to keep the pipe OPEN, as DSH does.
    const { code, seen, requests, exited } = await runHookAgainstHub(
      { session_id: "session-open-stdin", transcript_path: "", cwd: process.cwd(), hook_event_name: "SessionStart" },
      { closeStdin: false, timeoutMs: 5_000 },
    );
    expect(exited, "the hook must exit even when stdin is left open - otherwise it leaks").toBe(true);
    expect(code).toBe(0);
    // And it must still have DONE ITS JOB before exiting, not merely avoided hanging.
    expect(requests).toBeGreaterThan(0);
    expect(seen?.sess).toBe("session-open-stdin");
  }, 20_000);

  it("SENDS the chat's session id to the hub (the property the unit exists for)", async () => {
    // THE REAL PAYLOAD SHAPE, not a minimal one. DSH does not run hooks of its own format: it runs
    // a Claude Code hooks.json through the @deepseek-ai/dsh-hooks-claude-code bridge, which builds
    // this object and calls it a SessionStart payload -
    //     { session_id: agent.session.header.id, transcript_path: "", cwd: agent.session.header.cwd,
    //       hook_event_name: "SessionStart", source }
    // (read from the installed bridge, lib/index.js). A test that feeds `{ session_id }` alone
    // would pass against a shape production never sends, which is the difference between "my test
    // passes" and "my test uses the shape production sends".
    const realPayload = {
      session_id: "session-hook-1",
      transcript_path: "",
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
      source: "startup",
    };
    const { code, seen, requests } = await runHookAgainstHub(realPayload);
    expect(code).toBe(0);
    // A request was actually made, carrying THIS chat's identity and naming the dsh client.
    expect(requests).toBeGreaterThan(0);
    expect(seen?.sess).toBe("session-hook-1");
    expect(seen?.client).toBe("dsh");
  }, 20_000);

  it("still works with a minimal payload (the fields it needs, nothing else)", async () => {
    // Belt and braces: the hook must not depend on fields the bridge happens to add today.
    const { code, seen } = await runHookAgainstHub({ session_id: "session-min-1", cwd: process.cwd() });
    expect(code).toBe(0);
    expect(seen?.sess).toBe("session-min-1");
  }, 20_000);

  it("sends nothing when the bridge supplies an EMPTY session id", async () => {
    // The bridge sends `session_id: ""` when no agent is available - an empty string, not a
    // missing key. That is the realistic absence case, and it must produce no request.
    const { code, requests } = await runHookAgainstHub({
      session_id: "",
      transcript_path: "",
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
    });
    expect(code).toBe(0);
    expect(requests).toBe(0);
  }, 20_000);

  it("sends nothing at all when there is no session id", async () => {
    // The negative that matters: no id means no request, rather than a request under a default.
    const { code, requests } = await runHookAgainstHub({ cwd: process.cwd() });
    expect(code).toBe(0);
    expect(requests).toBe(0);
  }, 20_000);

  it("treats a malformed payload as nothing to do rather than an error", async () => {
    const { code, requests } = await runHookAgainstHub("not json at all");
    expect(code).toBe(0);
    expect(requests).toBe(0);
  }, 20_000);
});

/**
 * RESTART CONTINUITY — MEASURED, not assumed, and the measurement is what unblocked this.
 *
 * This was `describe.skip` pending the gating question (#207: does a DSH session id survive
 * /clear, compaction and a restart?). It is now answered from a real restart observed by this
 * agent, which is the unit's own subject:
 *
 *   before restart : DSH_SESSION_ID = session-1068eb47-cda7-4ab9-bf6f-18f42eff994e
 *   after  restart : DSH_SESSION_ID = session-1068eb47-cda7-4ab9-bf6f-18f42eff994e   (identical)
 *
 * and the supporting evidence that it is the SAME session rather than a fresh one reusing a
 * name: the DSH store directory of that id was CREATED before the restart and its transcript was
 * still being appended to afterwards, and three OTHER session directories appeared around the
 * restart while this one did not move. So a resumed chat keeps its id, and a new chat gets a new
 * one.
 *
 * WHAT THIS DOES AND DOES NOT SETTLE, because overclaiming here would be the same defect this
 * suite exists to catch:
 *   - SETTLED: an id is stable across a restart of the harness, so `env:DSH_SESSION_ID` needs no
 *     keeper variable. (The dsh row declares nothing at all for a different reason - the hook
 *     supplies the id - so this only matters for the CLI path.)
 *   - NOT SETTLED HERE: /clear and compaction were not observed by this measurement. The
 *     evidence is consistent with them preserving the id - the store keys the transcript by it -
 *     but "consistent with" is not "measured", so this file does not assert it.
 *
 * The tests below assert the PROPERTY that makes restart-survival useful rather than hardcoding
 * the observed value: a session id is stable across processes, so the same chat resolves to the
 * same identity rather than churning into a second agent.
 */
describe("unit 2: restart continuity (measured; #207 answered)", () => {
  it("a stable id resolves to the SAME identity in two separate resolves", () => {
    // The property restart-survival exists to provide: a resumed chat is the same agent, not a
    // second one. Two resolves with the same id must produce the same session header.
    const home = homeWithDevice();
    const first = resolveHub({ client: "dsh", home, env: noEnv, sessionId: "survives-restart", cwd: home });
    const second = resolveHub({ client: "dsh", home, env: noEnv, sessionId: "survives-restart", cwd: home });
    expect(sessionOf(first)).toBe("survives-restart");
    expect(sessionOf(second)).toBe("survives-restart");
    // Same identity both times - the credential is the machine, the header the chat.
    expect(first.key).toBe(second.key);
  });

  it("DSH_SESSION_ID is stable across separate PROCESSES, which is what restart survival means", () => {
    // The mechanism behind the observed restart result: the variable is not regenerated per
    // child process. Three fresh shells must report the same value, or a resumed chat would land
    // as a new agent the first time it ran a command.
    const values = [0, 1, 2].map(() => {
      const out = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.DSH_SESSION_ID || '')"], {
        env: process.env,
        encoding: "utf8",
      });
      return out.stdout.trim();
    });
    // Only assert if this suite is genuinely running inside a DSH session - otherwise there is
    // nothing to measure and asserting would be a false failure on another harness.
    if (!values[0]) {
      expect(values.every((v) => v === "")).toBe(true);
      return;
    }
    expect(values[0]).not.toBe("");
    expect(new Set(values).size, `DSH_SESSION_ID differed across processes: ${JSON.stringify(values)}`).toBe(1);
  });
});