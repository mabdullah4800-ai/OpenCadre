import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

// Every test here starts the hook as a child process, so the describe uses the spawn timeout.

const HOOK = path.join(process.cwd(), "scripts", "wake-state-hook.mjs");
const SECRET = "agt_never_write_this_key_0123456789";

function runHook(base: string, surface: string, stdin: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--surface", surface], {
      env: { ...process.env, OPENCADRE_WAKE_STATE_DIR: base, OPENCADRE_KEY: SECRET },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

const stateFile = (base: string, sessionId: string) => path.join(base, "state", `${sessionId}.json`);
const readState = (base: string, sessionId: string) => JSON.parse(readFileSync(stateFile(base, sessionId), "utf8"));

type Step = [payload: Record<string, unknown>, status: string];

const CLIENTS: Record<string, { id: string; steps: Step[] }> = {
  "claude-code": {
    id: "claude-sess-1",
    steps: [
      [{ hook_event_name: "SessionStart", session_id: "claude-sess-1", source: "startup" }, "idle"],
      [{ hook_event_name: "UserPromptSubmit", session_id: "claude-sess-1", prompt: "hi" }, "busy"],
      [{ hook_event_name: "Notification", session_id: "claude-sess-1", notification_type: "permission_prompt" }, "blocked"],
      [{ hook_event_name: "Stop", session_id: "claude-sess-1" }, "idle"],
      [{ hook_event_name: "SessionEnd", session_id: "claude-sess-1", reason: "exit" }, "gone"],
    ],
  },
  codex: {
    id: "codex-thread-1",
    steps: [
      [{ hook_event_name: "SessionStart", session_id: "codex-thread-1" }, "idle"],
      [{ hook_event_name: "UserPromptSubmit", session_id: "codex-thread-1" }, "busy"],
      [{ hook_event_name: "PermissionRequest", session_id: "codex-thread-1" }, "blocked"],
      [{ hook_event_name: "Stop", session_id: "codex-thread-1" }, "idle"],
      [{ hook_event_name: "SessionEnd", session_id: "codex-thread-1" }, "gone"],
    ],
  },
  cursor: {
    id: "cursor-conv-1",
    steps: [
      [{ hook_event_name: "sessionStart", conversationId: "cursor-conv-1" }, "idle"],
      [{ hook_event_name: "beforeSubmitPrompt", conversationId: "cursor-conv-1" }, "busy"],
      [{ hook_event_name: "stop", conversationId: "cursor-conv-1", status: "completed" }, "idle"],
      [{ hook_event_name: "sessionEnd", sessionId: "cursor-conv-1" }, "gone"],
    ],
  },
  gemini: {
    id: "gemini-sess-1",
    steps: [
      [{ hook_event_name: "SessionStart", session_id: "gemini-sess-1" }, "idle"],
      [{ hook_event_name: "BeforeAgent", session_id: "gemini-sess-1" }, "busy"],
      [{ hook_event_name: "AfterAgent", session_id: "gemini-sess-1" }, "idle"],
      [{ hook_event_name: "SessionEnd", session_id: "gemini-sess-1" }, "gone"],
    ],
  },
};

describe("wake-state-hook", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  for (const [surface, { id, steps }] of Object.entries(CLIENTS)) {
    it(`writes the ${surface} status transitions`, async () => {
      const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
      for (const [payload, status] of steps) {
        const { code, out } = await runHook(base, surface, JSON.stringify(payload));
        expect(code).toBe(0);
        expect(out).toBe("");
        const state = readState(base, id);
        expect(state).toMatchObject({ surface, sessionId: id, status, agentKeyHash: null, waiterArmedAt: null });
        expect(Number.isNaN(Date.parse(state.since))).toBe(false);
        expect(typeof state.pid).toBe("number");
      }
    });
  }

  it("keeps since when the status does not change", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
    await runHook(base, "claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: "s-same" }));
    const first = readState(base, "s-same").since;
    await new Promise((r) => setTimeout(r, 20));
    await runHook(base, "claude-code", JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-same" }));
    expect(readState(base, "s-same").since).toBe(first);
  });

  it("writes nothing for an unknown event or a non-permission notification", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
    for (const payload of [
      { hook_event_name: "PostToolUse", session_id: "s-unknown" },
      { hook_event_name: "Notification", session_id: "s-unknown", notification_type: "idle_prompt" },
    ]) {
      const { code, out } = await runHook(base, "claude-code", JSON.stringify(payload));
      expect(code).toBe(0);
      expect(out).toBe("");
    }
    expect(existsSync(stateFile(base, "s-unknown"))).toBe(false);
  });

  it("exits 0 and writes nothing for malformed stdin or an unsafe session id", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
    for (const stdin of ["{not json", "", "null", JSON.stringify({ hook_event_name: "Stop", session_id: "../escape" })]) {
      const { code, out } = await runHook(base, "claude-code", stdin);
      expect(code).toBe(0);
      expect(out).toBe("");
    }
    expect(existsSync(path.join(base, "escape.json"))).toBe(false);
    expect(existsSync(path.join(base, "state")) ? readdirSync(path.join(base, "state")) : []).toEqual([]);
  });

  it("leaves a valid file under concurrent writes for one session", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
    const events = Array.from({ length: 10 }, (_, i) => (i % 2 ? "Stop" : "UserPromptSubmit"));
    const runs = await Promise.all(events.map((e) => runHook(base, "claude-code", JSON.stringify({ hook_event_name: e, session_id: "s-race" }))));
    expect(runs.every((r) => r.code === 0 && r.out === "")).toBe(true);
    expect(["busy", "idle"]).toContain(readState(base, "s-race").status);
    expect(readdirSync(path.join(base, "state"))).toEqual(["s-race.json"]);
  });

  it("never writes the agent key", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "wake-state-"));
    await runHook(base, "codex", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-key" }));
    expect(readFileSync(stateFile(base, "s-key"), "utf8")).not.toContain(SECRET);
  });
});
