import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { log, redact, setLogSink } from "../src/log.js";
import { withRequestLog } from "../src/http-log.js";

let restore: (() => void) | undefined;
function capture() {
  const lines: Array<Record<string, unknown>> = [];
  restore = setLogSink((line) => lines.push(JSON.parse(line)));
  vi.stubEnv("OPENCADRE_LOG_LEVEL", "debug");
  return lines;
}
afterEach(() => {
  restore?.();
  vi.unstubAllEnvs();
});

const AGENT_KEY = "agt_" + "a1b2c3d4".repeat(6);

describe("structured log", () => {
  it("writes one JSON object per line with ts, level and msg", () => {
    const lines = capture();
    log.info("hello", { orgId: "o1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "hello", orgId: "o1" });
    expect(Date.parse(String(lines[0].ts))).not.toBeNaN();
  });

  it("never prints keys: masks key-shaped strings anywhere and drops credential fields", () => {
    const lines = capture();
    log.warn(`bad key ${AGENT_KEY}`, {
      authorization: `Bearer ${AGENT_KEY}`,
      nested: { apiKey: AGENT_KEY, note: `used oc_ABCDEFGHJK and org_${"f".repeat(40)}` },
      error: new Error(`401 for ${AGENT_KEY}`),
    });
    const out = JSON.stringify(lines);
    expect(out).not.toContain(AGENT_KEY);
    expect(out).not.toContain("oc_ABCDEFGHJK");
    expect(out).not.toMatch(/org_f{40}/);
    expect(lines[0]).toMatchObject({ authorization: "[redacted]", nested: { apiKey: "[redacted]" } });
    expect(redact("plain text")).toBe("plain text");
  });

  it("respects OPENCADRE_LOG_LEVEL", () => {
    const lines = capture();
    vi.stubEnv("OPENCADRE_LOG_LEVEL", "warn");
    log.info("dropped");
    log.error("kept");
    expect(lines.map((l) => l.msg)).toEqual(["kept"]);
  });

  it("omits deep object subtrees before log serialization can expose credential fields", () => {
    const lines = capture();
    const sentinel = "DEEP_OBJECT_SENTINEL";
    log.warn("deep object", {
      payload: { one: { two: { three: { four: { password: sentinel, nested: { token: sentinel } } } } } },
    });
    expect(lines[0]).toMatchObject({
      payload: { one: { two: { three: { four: "[omitted: depth limit]" } } } },
    });
    expect(JSON.stringify(lines)).not.toContain(sentinel);
  });

  it("omits deep arrays including mixed object and array descendants", () => {
    const lines = capture();
    const sentinel = "DEEP_ARRAY_SENTINEL";
    log.warn("deep array", {
      payload: [[[{ kept: 1, overflow: [{ access_token: sentinel }, [{ client_secret: sentinel }]] }]]],
    });
    expect(lines[0]).toMatchObject({
      payload: [[[{ kept: 1, overflow: "[omitted: depth limit]" }]]],
    });
    expect(JSON.stringify(lines)).not.toContain(sentinel);
  });

  it("does not inspect or serialize a depth-omitted subtree", () => {
    const lines = capture();
    const toJSON = vi.fn(() => ({ password: "SERIALIZATION_SENTINEL" }));
    const readPassword = vi.fn(() => "GETTER_SENTINEL");
    const overflow = { toJSON };
    Object.defineProperty(overflow, "password", { enumerable: true, get: readPassword });
    log.warn("omitted serialization", { payload: { one: { two: { three: { four: overflow } } } } });
    expect(toJSON).not.toHaveBeenCalled();
    expect(readPassword).not.toHaveBeenCalled();
    expect(JSON.stringify(lines)).not.toContain("SENTINEL");
  });

  it("bounds cyclic objects and arrays so the log remains serializable", () => {
    const lines = capture();
    const object: Record<string, unknown> = { password: "CYCLE_SENTINEL" };
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    expect(() => log.warn("cycles", { object, array })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      object: {
        password: "[redacted]",
        self: { password: "[redacted]", self: { password: "[redacted]", self: { password: "[redacted]", self: "[omitted: depth limit]" } } },
      },
      array: [[[["[omitted: depth limit]"]]]],
    });
    expect(JSON.stringify(lines)).not.toContain("CYCLE_SENTINEL");
  });

  it("preserves boundary primitives, normal shape, shallow masking and Error projection", () => {
    const lines = capture();
    const error = Object.assign(new Error("password=ERROR_SENTINEL"), { token: "ERROR_PROPERTY_SENTINEL" });
    log.warn("controls", {
      password: "SHALLOW_SENTINEL",
      normal: ["plain", 7, false, null],
      payload: { one: { two: { three: {
        text: "plain boundary",
        number: 7,
        flag: false,
        empty: null,
        masked: "password=BOUNDARY_SENTINEL",
        error,
      } } } },
    });
    expect(lines[0]).toMatchObject({
      password: "[redacted]",
      normal: ["plain", 7, false, null],
      payload: { one: { two: { three: {
        text: "plain boundary",
        number: 7,
        flag: false,
        empty: null,
        masked: "password=***",
        error: { name: "Error", message: "password=***" },
      } } } },
    });
    expect(JSON.stringify(lines)).not.toContain("SENTINEL");
  });
});

describe("request log", () => {
  async function serve(handler: http.RequestListener) {
    const server = http.createServer(withRequestLog(handler));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("logs method, path without the query, status, duration and the authenticated ids, and echoes a request id", async () => {
    const lines = capture();
    const { base, close } = await serve((req, res) => {
      Object.assign(req, { orgId: "o1", agentId: "a1" });
      res.end("ok");
    });
    const res = await fetch(`${base}/v1/messages?apiKey=${AGENT_KEY}`);
    await close();
    const entry = lines.find((l) => l.msg === "request")!;
    expect(entry).toMatchObject({ level: "info", method: "GET", path: "/v1/messages", status: 200, orgId: "o1", agentId: "a1" });
    expect(typeof entry.ms).toBe("number");
    expect(res.headers.get("x-request-id")).toBe(entry.requestId);
    expect(JSON.stringify(lines)).not.toContain(AGENT_KEY);
  });

  it("keeps a safe caller request id, replaces an unsafe one, and logs 5xx as error", async () => {
    const lines = capture();
    const { base, close } = await serve((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const kept = await fetch(`${base}/v1/x`, { headers: { "x-request-id": "trace-1234abcd" } });
    const replaced = await fetch(`${base}/v1/x`, { headers: { "x-request-id": "bad id <injected> with spaces" } });
    await close();
    expect(kept.headers.get("x-request-id")).toBe("trace-1234abcd");
    expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.filter((l) => l.msg === "request").every((l) => l.level === "error")).toBe(true);
  });

  it("logs static assets at debug, not info", async () => {
    const lines = capture();
    const { base, close } = await serve((_req, res) => res.end());
    await fetch(`${base}/app/app.css`);
    await close();
    expect(lines.find((l) => l.path === "/app/app.css")?.level).toBe("debug");
  });
});
