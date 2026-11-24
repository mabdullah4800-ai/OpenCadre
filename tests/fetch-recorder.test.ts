import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFetchRecorder } from "./helpers/fetch-recorder.js";

const servers: http.Server[] = [];
const factory = (listener: http.RequestListener) => {
  const server = http.createServer(listener);
  servers.push(server);
  return server;
};
const badPort = () => new TypeError("fetch failed", { cause: new Error("bad port") });
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Fetch-ready recording fixture", () => {
  it("readiness traffic never reaches the recorder; real traffic still does", async () => {
    const seen: string[] = [];
    const recorder = await startFetchRecorder((req, res) => {
      seen.push(req.url!);
      res.end("observed");
    }, { serverFactory: factory });
    try {
      expect(seen).toEqual([]);
      expect(await (await fetch(`${recorder.url}/actual`)).text()).toBe("observed");
      expect(seen).toEqual(["/actual"]);
    } finally { await recorder.close(); }
  });

  it("only explicit bad-port rejection rebinds, after closing the rejected server", async () => {
    let calls = 0;
    const recorder = await startFetchRecorder((_req, res) => res.end(), {
      serverFactory: factory,
      fetchImpl: async (url, init) => {
        if (++calls === 1) throw badPort();
        expect(servers[0].listening).toBe(false);
        expect(servers[0].address()).toBeNull();
        // Classification/cleanup control is deterministic even if the next OS port is also blocked.
        // The preceding test and the project-allowlist suite supply the real Fetch positive control.
        return new Response(null, { status: 204 });
      },
    });
    try {
      expect(calls).toBe(2);
      expect(servers).toHaveLength(2);
      expect(recorder.server.listening).toBe(true);
    } finally { await recorder.close(); }
  });

  it("propagates other transport errors without retry, and closes the owned server", async () => {
    const failure = new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    await expect(startFetchRecorder((_req, res) => res.end(), {
      serverFactory: factory, fetchImpl: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("a bare bad-port message is not enough to retry", async () => {
    const failure = new Error("bad port");
    await expect(startFetchRecorder((_req, res) => res.end(), {
      serverFactory: factory, fetchImpl: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("bounds bad-port exhaustion and leaves every rejected server closed", async () => {
    await expect(startFetchRecorder((_req, res) => res.end(), {
      maxAttempts: 2, serverFactory: factory, fetchImpl: async () => { throw badPort(); },
    })).rejects.toThrow("No Fetch-ready recorder after 2 attempts");
    expect(servers).toHaveLength(2);
    expect(servers.every((server) => !server.listening && server.address() === null)).toBe(true);
  });

  it("a stalled probe times out, is aborted and does not rebind", async () => {
    let signal: AbortSignal | undefined;
    await expect(startFetchRecorder((_req, res) => res.end(), {
      probeTimeoutMs: 30, serverFactory: factory,
      fetchImpl: async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      },
    })).rejects.toThrow("Recorder readiness timed out");
    expect(signal?.aborted).toBe(true);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("listen errors propagate before probing, without retry", async () => {
    const failure = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    let probed = false;
    await expect(startFetchRecorder((_req, res) => res.end(), {
      serverFactory: (listener) => {
        const server = factory(listener);
        server.listen = (() => {
          queueMicrotask(() => server.emit("error", failure));
          return server;
        }) as typeof server.listen;
        return server;
      },
      fetchImpl: async () => { probed = true; return new Response(null, { status: 204 }); },
    })).rejects.toBe(failure);
    expect(probed).toBe(false);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("listen readiness also has a deadline and aborts a stalled bind", async () => {
    let signal: AbortSignal | undefined;
    await expect(startFetchRecorder((_req, res) => res.end(), {
      probeTimeoutMs: 30,
      serverFactory: (listener) => {
        const server = factory(listener);
        server.listen = ((options: { signal: AbortSignal }) => {
          signal = options.signal;
          return server;
        }) as typeof server.listen;
        return server;
      },
    })).rejects.toThrow("Recorder readiness timed out");
    expect(signal?.aborted).toBe(true);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });

  it("an unexpected readiness response fails without retry or recording traffic", async () => {
    const seen: string[] = [];
    await expect(startFetchRecorder((req, res) => { seen.push(req.url!); res.end(); }, {
      serverFactory: factory, fetchImpl: async () => new Response(null, { status: 500 }),
    })).rejects.toThrow("Recorder readiness returned HTTP 500");
    expect(seen).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0].listening).toBe(false);
  });
});
