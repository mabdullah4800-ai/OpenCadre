import { describe, expect, it, vi } from "vitest";
import {
  registerSocket, pushToAgent, isOnline, waitForReply, resolveReplyWaiter,
  waitForInboxActivity, resolveAllInboxWaiters,
} from "../src/live.js";

function fakeSocket() {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe("live push registry", () => {
  it("delivers a push to a registered, open socket", () => {
    const ws = fakeSocket();
    registerSocket("agent-1", ws as never);
    const delivered = pushToAgent("agent-1", { type: "message", body: "hi" });
    expect(delivered).toBe(true);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "message", body: "hi" });
  });

  it("reports not-delivered for an agent with no socket", () => {
    expect(pushToAgent("nobody-registered", { type: "message" })).toBe(false);
  });

  it("reports offline once the socket closes", () => {
    const ws = fakeSocket();
    registerSocket("agent-2", ws as never);
    expect(isOnline("agent-2")).toBe(true);
    ws.emit("close");
    expect(isOnline("agent-2")).toBe(false);
    expect(pushToAgent("agent-2", { type: "message" })).toBe(false);
  });

  it("does not deliver through a socket that is no longer OPEN", () => {
    const ws = fakeSocket();
    ws.readyState = 3; // CLOSED
    registerSocket("agent-3", ws as never);
    expect(pushToAgent("agent-3", { type: "message" })).toBe(false);
  });
});

describe("waitForReply / resolveReplyWaiter", () => {
  it("resolves with the reply body when resolveReplyWaiter fires before the timeout", async () => {
    const p = waitForReply("thread-1", 5000);
    resolveReplyWaiter("thread-1", "the answer");
    await expect(p).resolves.toBe("the answer");
  });

  it("resolves null if nothing replies before the timeout", async () => {
    vi.useFakeTimers();
    const p = waitForReply("thread-2", 1000);
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("resolving an unrelated thread id never affects a different pending wait", async () => {
    const p = waitForReply("thread-3", 5000);
    resolveReplyWaiter("some-other-thread", "wrong answer");
    resolveReplyWaiter("thread-3", "right answer");
    await expect(p).resolves.toBe("right answer");
  });

  it("a resolve after the timeout already fired is a harmless no-op", async () => {
    vi.useFakeTimers();
    const p = waitForReply("thread-4", 100);
    vi.advanceTimersByTime(101);
    const result = await p;
    expect(result).toBeNull();
    // Late resolve must not throw even though the waiter has already been cleaned up.
    expect(() => resolveReplyWaiter("thread-4", "too late")).not.toThrow();
    vi.useRealTimers();
  });
});

describe("resolveAllInboxWaiters (graceful shutdown)", () => {
  it("unblocks every pending long-poll immediately, across multiple agents", async () => {
    const start = Date.now();
    const p1 = waitForInboxActivity("shutdown-agent-1", 30000);
    const p2 = waitForInboxActivity("shutdown-agent-2", 30000);
    resolveAllInboxWaiters();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Real proof this isn't coincidentally fast: it must not have waited
    // anywhere near the 30s timeout each was holding for.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("multiple waiters on the SAME agent are all unblocked, not just the first", async () => {
    const p1 = waitForInboxActivity("shutdown-agent-3", 30000);
    const p2 = waitForInboxActivity("shutdown-agent-3", 30000);
    resolveAllInboxWaiters();
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
  });

  it("is a harmless no-op when nothing is waiting", () => {
    expect(() => resolveAllInboxWaiters()).not.toThrow();
  });
});

// Watchers dedupe live pushes against polled mail by message id; without it
// they fell back to thread+body keys and dropped repeated identical bodies.
describe("live push payloads", () => {
  it("carry the stored message id for messages, questions and replies", async () => {
    const { createOrganization, registerAgent, sendMessage, askClarification, reply, getMessages } = await import("../src/service.js");
    const { orgId } = createOrganization("Push Id Org");
    const a = registerAgent(orgId, "Push-A");
    const b = registerAgent(orgId, "Push-B");
    const wsA = fakeSocket();
    const wsB = fakeSocket();
    registerSocket(a.agentId, wsA as never);
    registerSocket(b.agentId, wsB as never);

    const sent = await sendMessage(orgId, { id: a.agentId, name: "Push-A" }, "Push-B", "hello");
    await askClarification(orgId, { id: a.agentId, name: "Push-A" }, "Push-B", "ok?", 0);
    const inbox = getMessages(orgId, b.agentId, undefined, { peek: true });
    const pushed = wsB.sent.map((s) => JSON.parse(s));
    expect(pushed.map((p) => p.id)).toEqual(inbox.map((m) => m.id));

    if (!sent.ok) throw new Error("send failed");
    reply(orgId, { id: b.agentId, name: "Push-B" }, sent.threadId, "hi back");
    const [replyRow] = getMessages(orgId, a.agentId, undefined, { peek: true });
    expect(JSON.parse(wsA.sent.at(-1)!)).toMatchObject({ type: "reply", id: replyRow.id });
  });
});

// Proxies drop idle WebSockets (the Supervisor's /live closed with 1006 every ~15-20 min), and a
// silently dead client would otherwise count as "live" and swallow pushes. The hub pings on an
// interval and terminates any socket that didn't answer the previous ping.
describe("live socket keepalive", () => {
  function pingableSocket() {
    const ws = fakeSocket() as ReturnType<typeof fakeSocket> & { pings: number; terminated: boolean; ping(): void; terminate(): void };
    ws.pings = 0;
    ws.terminated = false;
    ws.ping = () => { ws.pings++; };
    ws.terminate = () => { ws.terminated = true; ws.emit("close"); };
    return ws;
  }

  it("pings live sockets, keeps ones that answer, and terminates ones that don't", async () => {
    const { trackKeepalive, sweepKeepalive } = await import("../src/live.js");
    const answers = pingableSocket();
    const silent = pingableSocket();
    const beats: string[] = [];
    trackKeepalive(answers as never, () => beats.push("answers"));
    trackKeepalive(silent as never, () => beats.push("silent"));

    sweepKeepalive([answers, silent] as never);
    expect(answers.pings).toBe(1);
    expect(silent.pings).toBe(1);

    answers.emit("pong");
    sweepKeepalive([answers, silent] as never);
    expect(answers.terminated).toBe(false);
    expect(answers.pings).toBe(2);
    expect(silent.terminated).toBe(true);
    expect(beats).toEqual(["answers"]);
  });
});
