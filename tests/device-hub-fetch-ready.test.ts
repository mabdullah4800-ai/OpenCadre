// startHub() (tests/helpers/device-hub.ts) must hand its callers a port Fetch will actually use. An OS-assigned port can be
// one the Fetch standard blocks ("bad port"; WHATWG Fetch "port blocking"), and this PC's dynamic range starts at 1024, so
// a bare listen(0) failed suite runs in enableProject/mintDevice: the checkout gate r1 (grok-harness) and #736 run 2
// (connector-build-api), both "fetch failed" caused by "bad port". The rebind, exhaustion and cleanup controls inject the
// probe's outcome, so they are deterministic and never skip; only the real blocked-port reproduction can skip, and only
// when every listed port is already taken.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "./helpers/device-hub.js";

const badPort = () => new TypeError("fetch failed", { cause: new Error("bad port") });
const servers: http.Server[] = [];
const factory = (listener: http.RequestListener) => {
  const server = http.createServer(listener);
  servers.push(server);
  return server;
};
const closeQuietly = (server: http.Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});
/** The settled outcome of a startHub that is expected to fail. A hub that starts anyway (a regression, or the old
 * listen(0) helper, which ignores the options) is closed first, so a failing assertion never leaves a server running. */
const outcomeOf = (started: ReturnType<typeof startHub>) =>
  started.then(async (hub) => { await hub.close(); return "a hub started" as const; }, (error: unknown) => error);
/** GET over node:http, which (unlike Fetch) blocks no port, so a check of the served hub cannot itself hit "bad port". */
const httpStatus = (url: string) => new Promise<number>((resolve, reject) => {
  http.get(url, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }).on("error", reject);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeQuietly(server);
});

describe("startHub hands out a Fetch-usable port", () => {
  it("reproduces the failure class: Node's fetch refuses a server on a blocked port", async (ctx) => {
    let blocked: { server: http.Server; port: number } | null = null;
    for (const port of [6000, 6666, 10080]) {
      const server = http.createServer((_req, res) => res.end("ok"));
      const bindError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        server.once("error", (error: NodeJS.ErrnoException) => resolve(error));
        server.listen(port, "127.0.0.1", () => resolve(null));
      });
      if (!bindError) { blocked = { server, port }; break; }
      await closeQuietly(server);
      // Only an occupied port moves on to the next candidate; any other bind failure is a real error, not a skip.
      if (bindError.code !== "EADDRINUSE") throw bindError;
    }
    if (!blocked) return ctx.skip("ports 6000, 6666 and 10080 are all in use on this machine");
    try {
      const failure = await fetch(`http://127.0.0.1:${blocked.port}/`).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as { cause?: { message?: string } }).cause?.message).toBe("bad port");
    } finally {
      await closeQuietly(blocked.server);
    }
  });

  it("rebinds after a bad-port probe, closes the rejected server, and serves the hub on the new port", async () => {
    // Both probe outcomes are scripted (refused, then the readiness 204), so exactly two attempts happen whatever ports
    // the OS hands out; a real Fetch to the second port could itself be refused and force a legitimate third attempt.
    let probes = 0;
    const fetchImpl: typeof fetch = async () => {
      probes += 1;
      if (probes === 1) throw badPort();
      return new Response(null, { status: 204 });
    };
    const hub = await startHub({ fetchImpl, serverFactory: factory });
    try {
      expect(probes).toBe(2);
      expect(servers).toHaveLength(2);
      expect(servers[0].listening).toBe(false);
      expect(servers[1].listening).toBe(true);
      expect(hub.url).toBe(`http://127.0.0.1:${(servers[1].address() as AddressInfo).port}`);
      expect(await httpStatus(`${hub.url}/health`)).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it("does not retry any other probe failure: the error propagates and the server is closed", async () => {
    const other = new TypeError("fetch failed", { cause: new Error("connect ECONNRESET") });
    const fetchImpl: typeof fetch = async () => { throw other; };
    expect(await outcomeOf(startHub({ fetchImpl, serverFactory: factory }))).toBe(other);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("gives up after three bad-port attempts, with every rejected server closed", async () => {
    let probes = 0;
    const fetchImpl: typeof fetch = async () => { probes += 1; throw badPort(); };
    const outcome = await outcomeOf(startHub({ fetchImpl, serverFactory: factory }));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("No Fetch-ready recorder after 3 attempts");
    expect(probes).toBe(3);
    expect(servers).toHaveLength(3);
    for (const server of servers) expect(server.listening).toBe(false);
  });

  it("with no options: a working hub, and close() frees its port", async () => {
    const hub = await startHub();
    try {
      const res = await fetch(`${hub.url}/health`);
      expect(res.status).toBe(200);
    } finally {
      await hub.close();
    }
    const after = await fetch(`${hub.url}/health`).then(() => "answered", () => "refused");
    expect(after).toBe("refused");
  });
});
