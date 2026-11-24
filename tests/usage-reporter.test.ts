import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, listActiveAgents, registerAgent } from "../src/service.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

// Every test here starts the reporter as a child process, so every describe uses the spawn timeout.

const REPORTER = path.join(process.cwd(), "scripts", "opencadre-usage.mjs");

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setup(name: string) {
  const { orgId } = createOrganization(name);
  const agent = registerAgent(orgId, "Usage-Reporter");
  const env = {
    OPENCADRE_URL: baseUrl, OPENCADRE_KEY: agent.apiKey,
    OPENCADRE_HOOK_HOME: mkdtempSync(path.join(tmpdir(), "usage-home-")),
    OPENCADRE_WAKE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "usage-state-")),
  };
  const usage = () => listActiveAgents(orgId).find((a) => a.id === agent.agentId)!.usage;
  return { env, key: agent.apiKey, usage };
}

function run(args: string[], env: Record<string, string>, stdin = ""): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    // A developer's relocated Codex home must not redirect a synthetic fixture into real rollout files.
    // Explicit per-test CODEX_HOME overrides still win.
    const child = spawn(process.execPath, [REPORTER, ...args], { env: { ...process.env, CODEX_HOME: "", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

// Derived from the clock, never pasted. A pasted absolute epoch is a time bomb: `currentUsage`
// (src/usage.ts:81) un-limits any stored report whose resetsAt has already passed, so the two
// tests asserting `limited: true` began failing the instant the literal went stale — measured
// 2026-09-19: RESETS_AT was 1789838098 = 17:14:58Z and main went red at 17:14:58Z, to the second.
// Every assertion computes its ISO string from this value; never paste one.
const RESETS_AT = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
const rateLimitLine = (rateLimits: unknown) =>
  JSON.stringify({ timestamp: "2026-09-13T10:00:00Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rateLimits } });
const codexLimits = (overrides: Record<string, unknown> = {}) => ({
  limit_id: "codex",
  primary: { used_percent: 77.0, window_minutes: 10080, resets_at: RESETS_AT },
  secondary: null,
  credits: { has_credits: false },
  plan_type: "prolite",
  rate_limit_reached_type: null,
  ...overrides,
});

function writeRollout(home: string, day: string, name: string, lines: string[], mtimeSec?: number) {
  const dir = path.join(home, ".codex", "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  if (mtimeSec) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

describe("opencadre-usage.mjs --client codex", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("sends only mapped usage fields on the wire, not synthetic conversation text or the rollout", async () => {
    const { env } = setup("Usage Codex Wire Privacy Org");
    const userMarker = "synthetic-private-user-message";
    const assistantMarker = "synthetic-private-assistant-reply";
    const file = writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/13", "rollout-wire-privacy.jsonl", [
      JSON.stringify({ type: "response_item", payload: { role: "user", text: userMarker } }),
      rateLimitLine(codexLimits()),
      JSON.stringify({ type: "response_item", payload: { role: "assistant", text: assistantMarker } }),
    ]);
    const received: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
    const recorder = await startFetchRecorder(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const previousCodexHome = process.env.CODEX_HOME;
    // A known-wrong synthetic inherited root must not redirect this child away from the fixture.
    process.env.CODEX_HOME = path.join(env.OPENCADRE_HOOK_HOME, "not-the-rollout-root");
    try {
      const result = await run(["--client", "codex"], { ...env, OPENCADRE_URL: recorder.url });
      expect(result).toEqual({ code: 0, out: "", err: "" });
      // A fail-silent reporter that sends nothing must fail this positive delivery control.
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ method: "POST", url: "/v1/usage" });
      expect(JSON.parse(received[0].body)).toEqual({
        usedPct: 77, window: "7d", resetsAt: new Date(RESETS_AT * 1000).toISOString(),
        limited: false, plan: "prolite", source: "codex",
      });
      // Check the outbound body, not hub-stored fields: the hub can discard unknown fields.
      expect(received[0].body).not.toContain(userMarker);
      expect(received[0].body).not.toContain(assistantMarker);
      expect(received[0].body).not.toContain(readFileSync(file, "utf8"));
      const cache = readdirSync(env.OPENCADRE_WAKE_STATE_DIR).map(name => readFileSync(path.join(env.OPENCADRE_WAKE_STATE_DIR, name), "utf8")).join("\n");
      expect(cache).not.toContain(userMarker);
      expect(cache).not.toContain(assistantMarker);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await recorder.close();
    }
  });

  it("posts the newest session's last rate_limits, mapped", async () => {
    const { env, key, usage } = setup("Usage Codex Org");
    writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/12", "rollout-2026-09-12T09-00-00-old.jsonl", [rateLimitLine(codexLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } }))]);
    writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/13", "rollout-2026-09-13T10-00-00-a.jsonl", [
      rateLimitLine(codexLimits({ primary: { used_percent: 10, window_minutes: 10080, resets_at: RESETS_AT } })),
      JSON.stringify({ type: "response_item", payload: { text: "no limits here" } }),
      rateLimitLine(codexLimits()),
      JSON.stringify({ type: "response_item", payload: { text: "after" } }),
    ]);
    const { code, out, err } = await run(["--client", "codex"], env);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(`${out}${err}`).not.toContain(key);
    expect(usage()).toMatchObject({
      usedPct: 77, window: "7d", resetsAt: new Date(RESETS_AT * 1000).toISOString(), limited: false, plan: "prolite", source: "codex",
    });
  });

  it("uses the fullest window and marks a reached limit as limited", async () => {
    const { env, usage } = setup("Usage Codex Reached Org");
    writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/13", "rollout-2026-09-13T11-00-00-b.jsonl", [rateLimitLine(codexLimits({
      primary: { used_percent: 42, window_minutes: 300, resets_at: RESETS_AT },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: RESETS_AT + 999 },
      rate_limit_reached_type: "rate_limit_reached",
    }))]);
    expect((await run(["--client", "codex"], env)).code).toBe(0);
    expect(usage()).toMatchObject({ usedPct: 42, window: "5h", resetsAt: new Date(RESETS_AT * 1000).toISOString(), limited: true });
  });

  it("posts nothing when both windows are null", async () => {
    const { env, usage } = setup("Usage Codex Null Org");
    writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/13", "rollout-2026-09-13T12-00-00-c.jsonl", [rateLimitLine(codexLimits({ primary: null, secondary: null }))]);
    expect((await run(["--client", "codex"], env)).code).toBe(0);
    expect(usage()).toBeNull();
  });

  it("posts at most once a minute, and repeats an unchanged report only after 5 minutes", async () => {
    const { env, usage } = setup("Usage Codex Throttle Org");
    const home = env.OPENCADRE_HOOK_HOME;
    const name = "rollout-2026-09-13T13-00-00-d.jsonl";
    writeRollout(home, "2026/09/13", name, [rateLimitLine(codexLimits())]);
    await run(["--client", "codex"], env);
    const first = usage()!;
    expect(first.usedPct).toBe(77);

    writeRollout(home, "2026/09/13", name, [rateLimitLine(codexLimits({ primary: { used_percent: 90, window_minutes: 10080, resets_at: RESETS_AT } }))]);
    await run(["--client", "codex"], env);
    expect(usage()).toEqual(first);

    const [stateName] = readdirSync(env.OPENCADRE_WAKE_STATE_DIR);
    const stateFile = path.join(env.OPENCADRE_WAKE_STATE_DIR, stateName);
    const backdate = (field: string, ms: number) => {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      writeFileSync(stateFile, JSON.stringify({ ...state, [field]: state[field] - ms }));
    };
    backdate("checkedAt", 61_000);
    await run(["--client", "codex"], env);
    const second = usage()!;
    expect(second.usedPct).toBe(90);

    backdate("checkedAt", 61_000);
    await run(["--client", "codex"], env);
    expect(usage()).toEqual(second);

    backdate("checkedAt", 61_000);
    backdate("postedAt", 5 * 60_000);
    await run(["--client", "codex"], env);
    expect(usage()!.reportedAt).not.toBe(second.reportedAt);
  });

  it("exits 0 quietly when the hub is down", async () => {
    const { env, key } = setup("Usage Codex Down Org");
    writeRollout(env.OPENCADRE_HOOK_HOME, "2026/09/13", "rollout-2026-09-13T14-00-00-e.jsonl", [rateLimitLine(codexLimits())]);
    const { code, out, err } = await run(["--client", "codex"], { ...env, OPENCADRE_URL: "http://127.0.0.1:1" });
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).not.toContain(key);
  });
});

describe("opencadre-usage.mjs --client claude-code", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const statusInput = (rateLimits?: unknown) => JSON.stringify({ hook_event_name: "Status", model: { display_name: "Opus" }, ...(rateLimits ? { rate_limits: rateLimits } : {}) });

  it("maps the statusLine rate_limits and prints a status line", async () => {
    const { env, key, usage } = setup("Usage Claude Org");
    const { code, out, err } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput({
      five_hour: { used_percentage: 43, resets_at: RESETS_AT },
      seven_day: { used_percentage: 12.5, resets_at: RESETS_AT + 3600 },
    }));
    expect(code).toBe(0);
    expect(out.trim()).toBe("usage 43% · 5h");
    expect(`${out}${err}`).not.toContain(key);
    expect(usage()).toMatchObject({
      usedPct: 43, window: "5h", resetsAt: new Date(RESETS_AT * 1000).toISOString(), limited: false, plan: null, source: "claude-code",
    });
  });

  it("reports a full window as out of usage", async () => {
    const { env, usage } = setup("Usage Claude Limited Org");
    const { out } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput({
      seven_day: { used_percentage: 100, resets_at: RESETS_AT },
    }));
    const d = new Date(RESETS_AT * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(out.trim()).toBe(`out of usage · resets ${hhmm}`);
    expect(usage()).toMatchObject({ usedPct: 100, window: "7d", limited: true });
  });

  // The boundary, pinned DELIBERATELY rather than left to whichever epoch a fixture happens to
  // carry. `currentUsage` (src/usage.ts:81) un-limits any stored report whose resetsAt has passed:
  // "A limit whose reset time has passed is over, even before the agent says so." This test is the
  // reason the two above must derive their epoch from the clock — a pasted absolute would silently
  // migrate this file into asserting the opposite behaviour, which is exactly what happened.
  it("does NOT read as limited when the reset time has already passed", async () => {
    const { env, usage } = setup("Usage Claude Lapsed Org");
    const past = Math.floor(Date.now() / 1000) - 3600;
    const { code, out } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput({
      seven_day: { used_percentage: 100, resets_at: past },
    }));
    expect(code).toBe(0);
    // TWO SURFACES, and they deliberately differ — do not "correct" one toward the other:
    //   - the HOOK's own stdout is built in-process from the report it just assembled, so it still
    //     says "out of usage" (it has no hub-side reader in the loop);
    //   - the HUB's read applies `currentUsage` (src/service.ts:484), which un-limits a lapsed
    //     window — "a limit whose reset time has passed is over, even before the agent says so".
    // The un-limiting is a READER property; the stored report is left alone, which is why the raw
    // resetsAt survives intact on the hub's view below. The HH:mm is computed from `past`, never
    // pasted — a pasted time here is the same time bomb this file was just red from.
    const d = new Date(past * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(out.trim()).toBe(`out of usage · resets ${hhmm}`);
    expect(usage(), "the hub's read un-limits a lapsed window").toMatchObject({
      usedPct: 100, window: "7d", limited: false, resetsAt: new Date(past * 1000).toISOString(),
    });
  });

  it("still prints a line, and posts nothing, before the first API response", async () => {
    const { env, usage } = setup("Usage Claude Empty Org");
    const { code, out } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput());
    expect(code).toBe(0);
    expect(out.trim()).toBe("usage n/a");
    expect(usage()).toBeNull();
  });

  it("prints the line and exits 0 when the hub is down", async () => {
    const { env } = setup("Usage Claude Down Org");
    const { code, out } = await run(["--client", "claude-code", "--from-stdin"], { ...env, OPENCADRE_URL: "http://127.0.0.1:1" }, statusInput({
      five_hour: { used_percentage: 43, resets_at: RESETS_AT },
    }));
    expect(code).toBe(0);
    expect(out.trim()).toBe("usage 43% · 5h");
  });

  // `Number.isFinite(1e18)` is true, but `new Date(1e18 * 1000).toISOString()` throws RangeError —
  // the guard is narrower than the conversion it protects. Before the range check, that throw
  // escaped the windows map and was swallowed by the entry-point catch, so the agent's usage
  // VANISHED from the hub rather than reporting without a reset time. Asserting `usage()` alone
  // cannot see this: the "before the first API response" case above is ALSO null, so the
  // discriminating catchers are that the OTHER window still reports and that the in-range control
  // still converts. Measured on main @6582e1f: this test failed with `usage()` === null.
  it("reports an out-of-range resets_at as null instead of dropping the whole report", async () => {
    const { env, usage } = setup("Usage Claude Range Org");
    const { code } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput({
      five_hour: { used_percentage: 91, resets_at: 1e18 },            // finite, unrepresentable as a Date
      seven_day: { used_percentage: 12, resets_at: RESETS_AT },      // the control: still in range
    }));
    expect(code).toBe(0);
    // The whole report survives, which is the thing the bug destroyed...
    expect(usage(), "the report must survive a bad resets_at").toMatchObject({
      usedPct: 91, window: "5h", resetsAt: null, limited: false, source: "claude-code",
    });
    // ...and an in-range value in the SAME payload still converts, so the guard is a range check
    // and not a blanket rejection. report() keeps only the fullest window, so assert on seven_day
    // by making it the fullest here rather than by reading a field the winner displaced.
    const other = setup("Usage Claude Range Control Org");
    const { code: c2 } = await run(["--client", "claude-code", "--from-stdin"], other.env, statusInput({
      five_hour: { used_percentage: 12, resets_at: 1e18 },
      seven_day: { used_percentage: 91, resets_at: RESETS_AT },
    }));
    expect(c2).toBe(0);
    expect(other.usage(), "an in-range sibling window still converts").toMatchObject({
      usedPct: 91, window: "7d", resetsAt: new Date(RESETS_AT * 1000).toISOString(),
    });
  });

  // NOT A CATCHER — measured: this passes on origin/main too, because 8.64e12 seconds never threw
  // even before the guard. It exists only to stop the range check being tightened into a blanket
  // rejection (a real risk: the limit is 8.64e15 in MILLISECONDS, so a seconds bound written as
  // 8.64e15 would reject everything). Do not read it as coverage of the defect above.
  it("still reports the widest value the fixed guard accepts (guards against over-tightening)", async () => {
    const { env, usage } = setup("Usage Claude Boundary Org");
    const { code } = await run(["--client", "claude-code", "--from-stdin"], env, statusInput({
      five_hour: { used_percentage: 5, resets_at: 8.64e12 },
    }));
    expect(code).toBe(0);
    expect(usage()).toMatchObject({ usedPct: 5, window: "5h", resetsAt: new Date(8.64e12 * 1000).toISOString() });
  });
});
