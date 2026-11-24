import http from "node:http";
import type { AddressInfo } from "node:net";

const READY_PATH = "/__opencadre_test_recorder_ready__";
type Options = {
  maxAttempts?: number;
  probeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  serverFactory?: (listener: http.RequestListener) => http.Server;
};

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Recorder readiness timed out"));
          controller.abort();
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function isBadPort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { name?: string; message?: string; cause?: { name?: string; message?: string } };
  return failure.name === "TypeError" && failure.message === "fetch failed"
    && failure.cause?.name === "Error" && failure.cause.message === "bad port";
}

/** Test-only: an OS-assigned TCP port can be forbidden by Fetch. Probe before using it as a hub;
 * retry only that explicit rejection. Readiness never reaches the caller's recording listener.
 * No product retries or host port-policy changes. See WHATWG Fetch §2.9 (read 2026-10-07). */
export async function startFetchRecorder(listener: http.RequestListener, options: Options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeout = options.probeTimeoutMs ?? 2000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
    || !Number.isInteger(timeout) || timeout < 1 || timeout > 2000) {
    throw new RangeError("Recorder requires 1–3 attempts and a 1–2000ms readiness timeout");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const factory = options.serverFactory ?? ((handler) => http.createServer(handler));
  let lastBadPort: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const server = factory((req, res) => {
      if (req.method === "GET" && req.url === READY_PATH) {
        req.resume();
        res.writeHead(204, { connection: "close" }).end();
      } else listener(req, res);
    });
    let url = "";
    try {
      await deadline((signal) => new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen({ port: 0, host: "127.0.0.1", signal });
      }), timeout);
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await deadline(async (signal) => {
        const response = await fetchImpl(`${url}${READY_PATH}`, { signal, redirect: "error" });
        await response.arrayBuffer();
        if (response.status !== 204) throw new Error(`Recorder readiness returned HTTP ${response.status}`);
      }, timeout);
      return { server, url, close: () => closeServer(server) };
    } catch (error) {
      await closeServer(server);
      if (!isBadPort(error)) throw error;
      lastBadPort = error;
      console.warn(`[test recorder] ${url}: Fetch rejected bad port; owned server closed (attempt ${attempt}/${maxAttempts})`);
    }
  }
  throw new Error(`No Fetch-ready recorder after ${maxAttempts} attempts`, { cause: lastBadPort });
}
