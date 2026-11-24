import type { EventEmitter } from "node:events";

type Socket = EventEmitter & { readyState: number; terminate(): void };
type Frame = Record<string, unknown>;

/** Test-only ownership for the separation case; it cannot change hub publication or authorization. */
export class ConsoleCase {
  private readonly controller = new AbortController();
  private readonly sockets = new Map<Socket, () => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  assertActive(): void { this.controller.signal.throwIfAborted(); }

  own<T extends Socket>(socket: T): T {
    this.assertActive();
    // A connecting ws emits error when terminated; retain an owned observer until close is observed.
    const onError = () => {};
    socket.on("error", onError);
    this.sockets.set(socket, onError);
    return socket;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    // Observe immediately, but return the original rejecting promise to the assertion/operation owner.
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  private wait<T>(socket: Socket, event: string, label: string, decode: (raw: unknown) => T,
    timeoutMs = 1000, timeoutValue?: () => T, useAbort = true): Promise<T> {
    return this.track(new Promise<T>((resolve, reject) => {
      const signal = this.controller.signal;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off(event, receive);
        socket.off("error", onError);
        if (event !== "close") socket.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const receive = (raw: unknown) => {
        try { finish(undefined, decode(raw)); }
        catch (error) { finish(new Error(`${label}: invalid frame`, { cause: error })); }
      };
      const onError = (error: Error) => { if (event !== "close") finish(new Error(`${label}: socket error`, { cause: error })); };
      const onClose = () => finish(new Error(`${label}: socket closed before ${event}`));
      const onAbort = () => finish(signal.reason);
      if (useAbort && signal.aborted) { finish(signal.reason); return; }
      socket.on(event, receive);
      socket.on("error", onError);
      if (event !== "close") socket.on("close", onClose);
      if (useAbort) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (timeoutValue) finish(undefined, timeoutValue());
        else finish(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
    }));
  }

  opened(socket: Socket, label: string): Promise<void> {
    return this.wait(socket, "open", label, () => undefined);
  }
  message(socket: Socket, label: string): Promise<Frame> {
    return this.wait(socket, "message", label, (raw) => JSON.parse((raw as { toString(): string }).toString()) as Frame);
  }
  hasMessageWithin(socket: Socket, timeoutMs: number, label: string): Promise<boolean> {
    return this.wait(socket, "message", label, () => true, timeoutMs, () => false);
  }

  operation<T>(label: string, produce: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    return this.track(new Promise<T>((resolve, reject) => {
      const signal = this.controller.signal;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const onAbort = () => finish(signal.reason);
      if (signal.aborted) { finish(signal.reason); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(`timed out waiting for ${label}`);
        finish(error);
        this.controller.abort(error);
      }, 1000);
      // Both branches observe the actual producer, including a result arriving after cancellation.
      void Promise.resolve().then(() => { this.assertActive(); return produce(signal); })
        .then((value) => finish(undefined, value), (error) => finish(error));
    }));
  }

  async hints<T>(label: string, sockets: Socket[], produce: (signal: AbortSignal) => T | Promise<T>): Promise<{ value: T; hints: Frame[] }> {
    const waits = sockets.map((socket, index) => this.message(socket, `${label} tab ${index + 1}`));
    const producer = this.operation(`${label} producer`, produce);
    try {
      const [value, hints] = await Promise.all([producer, Promise.all(waits)]);
      this.assertActive();
      return { value, hints };
    } catch (error) {
      this.controller.abort(error);
      await Promise.allSettled([producer, ...waits]);
      throw error;
    }
  }

  dispose(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort(new Error("console case cancelled"));
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.sockets].map(async ([socket, onError]) => {
        try {
          if (socket.readyState !== 3) {
            const closed = this.wait(socket, "close", "owned socket cleanup", () => undefined, 1000, undefined, false);
            try { socket.terminate(); } catch (error) { await closed.catch(() => {}); throw error; }
            await closed;
          }
        } finally { if (socket.readyState === 3) socket.off("error", onError); }
      }));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "owned socket cleanup failed");
      this.sockets.clear();
    })();
  }
}
