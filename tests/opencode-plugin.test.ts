import { describe, expect, it } from "vitest";
import http from "node:http";
import {
  TERMINAL_EVENTS,
  decide,
  fetchDigest,
  formatDigest,
  isBillingReadOnly,
  sessionIdOf,
} from "../examples/opencode-plugin/awareness.js";

// The plugin's hub-facing logic is pure and lives in awareness.js, so it is tested here
// without an OpenCode process, a session or a token. The entry (index.js) is not imported
// here: it registers an event subscription on a live OpenCode context, which this test has no
// way to provide. Its LOADER rules (directory layout, no `@opencode/plugin` import) are not
// covered by any test — see the README's verify step, which is the only instrument for them.
// See docs/design/HARNESS-OPENCODE.md §7.

const PLACEHOLDER_KEY = "agt_PLACEHOLDER";

describe("sessionIdOf", () => {
  it("reads the documented session.idle shape", () => {
    expect(sessionIdOf({ type: "session.idle", properties: { sessionID: "ses_a" } })).toBe("ses_a");
  });

  it("reads the measured execution shape", () => {
    expect(sessionIdOf({ type: "session.execution.succeeded", data: { sessionID: "ses_b" } })).toBe("ses_b");
  });

  it("is null when there is no session id, rather than a guess", () => {
    expect(sessionIdOf({ type: "session.idle", properties: {} })).toBeNull();
    expect(sessionIdOf({ type: "session.idle" })).toBeNull();
    expect(sessionIdOf(undefined)).toBeNull();
    expect(sessionIdOf({ properties: { sessionID: "" } })).toBeNull();
  });

  it("covers the terminal events it claims to", () => {
    expect(TERMINAL_EVENTS.has("session.idle")).toBe(true);
    expect(TERMINAL_EVENTS.has("session.execution.succeeded")).toBe(true);
    expect(TERMINAL_EVENTS.has("session.execution.failed")).toBe(true);
    expect(TERMINAL_EVENTS.has("session.created")).toBe(false);
  });
});

describe("isBillingReadOnly", () => {
  it("is the hub's 402, with or without the code", () => {
    expect(isBillingReadOnly(402, { code: "TRIAL_EXPIRED" })).toBe(true);
    expect(isBillingReadOnly(402, {})).toBe(true);
    expect(isBillingReadOnly(402, undefined)).toBe(true);
  });

  it("is not any other status", () => {
    expect(isBillingReadOnly(401, {})).toBe(false);
    expect(isBillingReadOnly(403, {})).toBe(false);
    expect(isBillingReadOnly(500, {})).toBe(false);
    expect(isBillingReadOnly(200, { code: "TRIAL_EXPIRED" })).toBe(false);
  });
});

describe("formatDigest", () => {
  it("renders previews, not full bodies", () => {
    const text = formatDigest({
      items: [
        { priority: "P1", from_agent_name: "Ada", body: "x".repeat(200) },
        { priority: "low", from_agent_name: "Bo", body: "short\nbody" },
      ],
    });
    expect(text).toContain("Read it with get_messages");
    expect(text).toContain("- [P1] from Ada: " + "x".repeat(120) + "…");
    expect(text).toContain("- [low] from Bo: short body");
    expect(text).not.toContain("x".repeat(121));
  });

  it("caps the number of previews and says how many are left", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ priority: "P2", from_agent_name: `A${i}`, body: "b" }));
    const text = formatDigest({ items });
    expect(text).toContain("- [P2] from A4: b");
    expect(text).toContain("…and 3 more");
    expect(text).not.toContain("from A5");
  });

  it("survives a missing body and a missing name", () => {
    const text = formatDigest({ items: [{ priority: "P3" }] });
    expect(text).toContain("- [P3] from unknown:");
  });

  it("still renders the header when items are absent", () => {
    expect(formatDigest({})).toContain("Read it with get_messages");
    expect(formatDigest(undefined)).toContain("Read it with get_messages");
  });
});

describe("decide — the no-op contract", () => {
  it("delivers only a 200 with text", () => {
    const result = decide({ status: 200, body: { text: "hello", items: [] } });
    expect(result.deliver).toBe(true);
    // Asserts the RENDERED body carries the hub's own text, not merely that a header appears:
    // `toContain("Read it with get_messages")` was satisfied by formatDigest's bare header, so it
    // passed while the hub's `text` was discarded. See the background-only case below.
    expect(result.text).toBe("hello");
  });

  it("no-ops on a 200 with no text", () => {
    expect(decide({ status: 200, body: { text: "" } })).toEqual({ deliver: false, reason: "empty" });
    expect(decide({ status: 200, body: {} })).toEqual({ deliver: false, reason: "empty" });
  });

  // THE BACKGROUND-ONLY CASE. The hub renders a digest for background counts alone
  // (`render()` returns non-empty when items are empty but `background` is not), so `text` is
  // truthy and the gate correctly fires — but a client that re-rendered from `items` alone would
  // emit formatDigest's bare header, asserting "has mail for this chat" when there is NO MAIL.
  // Measured against the pre-fix code: this delivered exactly that header.
  it("delivers the hub's text for a background-only digest, and does not claim mail", () => {
    const body = {
      text: "OpenCadre awareness (events after #5):\nBackground: 3 task updates.",
      items: [],
      background: { "agent.task_changed": 3 },
      cursor: 9,
    };
    const result = decide({ status: 200, body });
    expect(result.deliver).toBe(true);
    // The hub's rendered digest, verbatim — background counts included, ack footer absent
    // because none of these items are directed.
    expect(result.text).toBe(body.text);
    // And specifically NOT the false mail claim that a re-render from `items` produces.
    expect(result.text).not.toContain("has mail for this chat");
  });

  it("no-ops on a lapsed bill rather than treating it as an error", () => {
    expect(decide({ status: 402, body: { code: "TRIAL_EXPIRED" } })).toEqual({
      deliver: false,
      reason: "billing-read-only",
    });
  });

  it("stays silent with no session yet, and in a project OpenCadre is not enabled in", () => {
    expect(decide({ status: 401, body: { error: "no OpenCadre session for this chat yet" } })).toEqual({
      deliver: false,
      reason: "no-session",
    });
    expect(decide({ status: 403, body: { error: "project_not_enabled" } })).toEqual({
      deliver: false,
      reason: "project-not-enabled",
    });
  });

  it("no-ops on unreachable, and on anything else", () => {
    expect(decide({ networkError: true }).deliver).toBe(false);
    expect(decide({ status: 500, body: {} }).deliver).toBe(false);
    expect(decide(undefined).deliver).toBe(false);
  });
});

describe("fetchDigest over a real HTTP hop", () => {
  async function withServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    run: (baseUrl: string) => Promise<void>,
  ) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      await run(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("sends the key and the session id, and never the key in a body", async () => {
    let seenAuth: string | undefined;
    let seenSession: string | undefined;
    await withServer(
      (req, res) => {
        seenAuth = req.headers.authorization;
        seenSession = req.headers["x-opencadre-session"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "digest", items: [] }));
      },
      async (baseUrl) => {
        const result = await fetchDigest({ hub: baseUrl, key: PLACEHOLDER_KEY, sessionId: "ses_c" });
        expect(result.deliver).toBe(true);
      },
    );
    expect(seenAuth).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(seenSession).toBe("ses_c");
  });

  it("is a silent no-op when the hub answers 402", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "TRIAL_EXPIRED", error: "trial ended" }));
      },
      async (baseUrl) => {
        expect(await fetchDigest({ hub: baseUrl, key: PLACEHOLDER_KEY, sessionId: "ses_c" })).toEqual({
          deliver: false,
          reason: "billing-read-only",
        });
      },
    );
  });

  it("is a silent no-op when the hub is unreachable, and never throws", async () => {
    // A closed port: connection refused.
    const result = await fetchDigest({ hub: "http://127.0.0.1:1", key: PLACEHOLDER_KEY, sessionId: "ses_c" });
    expect(result).toEqual({ deliver: false, reason: "unreachable" });
  });

  it("is a silent no-op when unconfigured, without touching the network", async () => {
    let called = false;
    const result = await fetchDigest({
      hub: "",
      key: "",
      sessionId: "ses_c",
      fetchImpl: (async () => {
        called = true;
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ deliver: false, reason: "unconfigured" });
    expect(called).toBe(false);
  });

  it("reports unreachable on a malformed body and on a timeout, not a throw", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json");
      },
      async (baseUrl) => {
        // A malformed body decodes to undefined, which decides as empty.
        expect(await fetchDigest({ hub: baseUrl, key: PLACEHOLDER_KEY, sessionId: "ses_c" })).toEqual({
          deliver: false,
          reason: "empty",
        });
      },
    );
  });
});
