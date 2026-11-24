import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { appendExchange } from "../scripts/display-queue.mjs";
import {
  clearWakeIfNoPending,
  readPendingWake,
  signalAgentWake,
} from "../scripts/agent-wake-signal.mjs";

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "wake-signal-"));
  process.env.OPENCADRE_DISPLAY_PATH = path.join(stateDir, "display.jsonl");
  process.env.OPENCADRE_AGENT_WAKE_PATH = path.join(stateDir, "wake.jsonl");
});

afterEach(() => {
  delete process.env.OPENCADRE_DISPLAY_PATH;
  delete process.env.OPENCADRE_AGENT_WAKE_PATH;
});

describe("wake signal cleanup", () => {
  it("clearWakeIfNoPending clears stale wake lines when inbox is idle", () => {
    signalAgentWake({
      from: "ClaudeCode-Session",
      threadId: "thread-stale",
      body: "old wake",
    });
    expect(readPendingWake()).toHaveLength(1);
    expect(clearWakeIfNoPending()).toBe(true);
    expect(readPendingWake()).toHaveLength(0);
  });

  it("clearWakeIfNoPending skips when pending_agent_reply rows exist", () => {
    appendExchange({
      at: new Date().toISOString(),
      priority: "medium",
      inbound: {
        threadId: "thread-live",
        from: "ClaudeCode-Session",
        kind: "message",
        body: "needs reply",
        at: new Date().toISOString(),
      },
      shown: false,
      status: "pending_agent_reply",
    });
    signalAgentWake({
      from: "ClaudeCode-Session",
      threadId: "thread-live",
      body: "needs reply",
    });
    expect(clearWakeIfNoPending()).toBe(false);
    expect(readPendingWake()).toHaveLength(1);
  });

  it("agent-inbox-prompt emits INBOX_EMPTY when only stale wake signals remain", () => {
    signalAgentWake({
      from: "ClaudeCode-Session",
      threadId: "thread-stale",
      body: "stale timer wake",
    });
    const result = spawnSync("node", ["scripts/agent-inbox-prompt.mjs"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(result.stdout.trim()).toBe("OPENCADRE_INBOX_EMPTY");
    expect(readPendingWake()).toHaveLength(0);
  });
});
