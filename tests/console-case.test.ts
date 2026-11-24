import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleCase } from "./helpers/console-case.js";

class Socket extends EventEmitter {
  readyState = 1;
  terminated = 0;
  terminate() {
    const connecting = this.readyState === 0;
    this.terminated++;
    this.readyState = 3;
    if (connecting) this.emit("error", new Error("injected connecting cancellation"));
    this.emit("close");
  }
}

const cases = new Set<ConsoleCase>();
function fixture() {
  const scope = new ConsoleCase();
  cases.add(scope);
  const tabs = [scope.own(new Socket()), scope.own(new Socket())];
  return { scope, tabs };
}
afterEach(async () => {
  try { for (const scope of cases) await scope.dispose(); }
  finally { cases.clear(); vi.useRealTimers(); }
});

describe("owned console case lifecycle", () => {
  it("arms both tabs before the producer and preserves exact positive frames", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    const result = await scope.hints("positive", tabs, () => {
      for (const tab of tabs) tab.emit("message", Buffer.from('{"type":"workspace.changed"}'));
      return 201;
    });
    expect(result).toEqual({ value: 201, hints: [{ type: "workspace.changed" }, { type: "workspace.changed" }] });
    expect(tabs.map((tab) => tab.listenerCount("message"))).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    await scope.dispose();
    expect(tabs.map((tab) => tab.terminated)).toEqual([1, 1]);
    expect(tabs.map((tab) => tab.eventNames())).toEqual([[], []]);
  });

  it("fails a withheld frame at the existing 1s deadline with the exact phase/tab label", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    const observed = scope.hints("withheld", tabs, () => {
      tabs[0].emit("message", Buffer.from('{"type":"workspace.changed"}'));
      return 201;
    }).then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await observed)?.message).toContain("withheld tab 2");
    expect(tabs.map((tab) => tab.listenerCount("message"))).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a late producer without releasing a late result or losing its failure", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    let aborted = false;
    let late = 0;
    const observed = scope.hints("late", tabs, (signal) => new Promise<number>((resolve, reject) => {
      for (const tab of tabs) tab.emit("message", Buffer.from('{"type":"workspace.changed"}'));
      const timer = setTimeout(() => { late++; resolve(201); }, 2000);
      signal.addEventListener("abort", () => {
        aborted = true; clearTimeout(timer); reject(signal.reason);
      }, { once: true });
    })).then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await observed)?.message).toContain("late producer");
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(late).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(tabs.map((tab) => tab.listenerCount("message"))).toEqual([0, 0]);
  });

  it("drains both prearmed waits and cleans sockets after an injected producer failure", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    await expect(scope.hints("producer failure", tabs, () => { throw new Error("injected producer"); })).rejects.toThrow("injected producer");
    await scope.dispose();
    expect(tabs.map((tab) => tab.eventNames())).toEqual([[], []]);
    expect(tabs.map((tab) => tab.readyState)).toEqual([3, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a non-cooperative late result without releasing it to the case", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    let finished = false;
    let released = false;
    const observed = scope.hints("late non-cooperative", tabs, () => new Promise<number>((resolve) => {
      for (const tab of tabs) tab.emit("message", Buffer.from('{"type":"workspace.changed"}'));
      setTimeout(() => { finished = true; resolve(201); }, 2000);
    })).then(() => { released = true; return null; }, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await observed)?.message).toContain("late non-cooperative producer");
    await scope.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(true); // Observation/cancellation cannot stop a producer that ignores its signal.
    expect(released).toBe(false);
    expect(tabs.map((tab) => tab.eventNames())).toEqual([[], []]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns parse errors and cleans a partially opened socket on case cancellation", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    await expect(scope.hints("parse", tabs, () => {
      tabs[0].emit("message", Buffer.from("not-json"));
      return 201;
    })).rejects.toThrow("parse tab 1");
    await scope.dispose();
    const partial = new ConsoleCase();
    cases.add(partial);
    const connecting = partial.own(new Socket());
    connecting.readyState = 0;
    const opening = partial.opened(connecting, "partial setup").then(() => null, (error: Error) => error);
    await partial.dispose();
    expect(await opening).toBeInstanceOf(Error);
    expect(connecting.readyState).toBe(3);
    expect(connecting.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans both sockets in finally when a semantic assertion fails", async () => {
    vi.useFakeTimers();
    const { scope, tabs } = fixture();
    const work = async () => {
      try {
        const result = await scope.hints("assertion cleanup", tabs, () => {
          for (const tab of tabs) tab.emit("message", Buffer.from('{"type":"workspace.changed"}'));
          return 201;
        });
        expect(result.value, "injected semantic assertion").toBe(200);
      } finally { await scope.dispose(); }
    };
    await expect(work()).rejects.toThrow("injected semantic assertion");
    expect(tabs.map((tab) => tab.eventNames())).toEqual([[], []]);
    expect(tabs.map((tab) => tab.readyState)).toEqual([3, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
