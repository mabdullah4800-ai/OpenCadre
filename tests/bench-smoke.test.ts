import { describe, expect, it } from "vitest";
import { runBench } from "../scripts/bench-hub.js";

// CI-sized run of the load benchmark: the full runs are recorded in docs/planning/BENCHMARKS.md.
describe("hub benchmark smoke", () => {
  it("delivers every message exactly once under concurrent load", async () => {
    const result = await runBench(2, 3, 120, 12);
    expect(result).toMatchObject({ messages: 120, errors: 0, duplicates: 0, lost: 0 });
    expect(result.deliveryMs.p95).toBeGreaterThan(0);
  }, 60_000);
});
