import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendExchange,
  readPendingAgentReply,
} from "../scripts/display-queue.mjs";
import {
  checkSendAllowed,
  resetSendState,
  sendAgentReply,
} from "../scripts/agent-inbox.mjs";

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "agent-inbox-"));
  process.env.OPENCADRE_INBOX_STATE_DIR = stateDir;
  process.env.OPENCADRE_DISPLAY_PATH = path.join(stateDir, "display.jsonl");
  const realDisplay = path.join(process.env.HOME ?? "/tmp", ".cursor/opencadre-display.jsonl");
  if (process.env.OPENCADRE_DISPLAY_PATH === realDisplay) {
    throw new Error("agent-inbox tests must not use the live display queue");
  }
  resetSendState();
});

afterEach(() => {
  resetSendState();
  delete process.env.OPENCADRE_INBOX_STATE_DIR;
  delete process.env.OPENCADRE_DISPLAY_PATH;
});

function seedPending(threadId: string) {
  appendExchange({
    at: new Date().toISOString(),
    priority: "medium",
    inbound: {
      threadId,
      from: "ClaudeCode-Session",
      kind: "message",
      body: `mail for ${threadId}`,
      at: new Date().toISOString(),
    },
    shown: false,
    status: "pending_agent_reply",
  });
}

describe("agent inbox send guards", () => {
  it("blocks identical bodies across different threads in one turn window", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mcpCall = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { ok: true, text: "sent" };
    };

    seedPending("thread-a");
    seedPending("thread-b");
    seedPending("thread-c");

    const body = "Acknowledged — working on duplicate-send fix now.";
    const first = await sendAgentReply({ threadId: "thread-a", body, toAgent: "ClaudeCode-Session", mcpCall });
    const second = await sendAgentReply({ threadId: "thread-b", body, toAgent: "ClaudeCode-Session", mcpCall });
    const third = await sendAgentReply({ threadId: "thread-c", body, toAgent: "ClaudeCode-Session", mcpCall });

    expect(first.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("duplicate_body_cross_thread");
    expect(third.skipped).toBe(true);
    expect(third.reason).toBe("duplicate_body_cross_thread");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ threadId: "thread-a", body });
  });

  it("dedupes repeated threadId+body within the turn window", () => {
    expect(checkSendAllowed("thread-1", "same reply").allowed).toBe(true);
    fs.writeFileSync(
      path.join(stateDir, "opencadre-send-dedupe.json"),
      JSON.stringify({
        entries: [
          {
            key: "thread-1:same reply",
            bodyKey: "same reply",
            threadId: "thread-1",
            at: Date.now(),
          },
        ],
      }),
    );
    expect(checkSendAllowed("thread-1", "same reply").allowed).toBe(false);
  });

  it("marks replied immediately after a successful send", async () => {
    seedPending("thread-mark");
    const result = await sendAgentReply({
      threadId: "thread-mark",
      body: "Done.",
      toAgent: "ClaudeCode-Session",
      mcpCall: async () => ({ ok: true, text: "sent" }),
    });

    expect(result.ok).toBe(true);
    expect(readPendingAgentReply()).toHaveLength(0);
  });
});
