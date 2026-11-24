// Falsifier 8 (concurrent invocation across the switch) and falsifier 11 (legacy conversion), plan §2.D.
//
// Each generation's probe modules export which generation they are, through the whole closure (a static import, then a
// DYNAMIC import after an observed startup barrier, so a run spans a controlled switch). ONE id per run is the
// property. Light by default (20 runs); OPENCADRE_HEAVY_TESTS=1 runs 200 (the plan's number) -- other suites share this
// box, so the heavy variant is opt-in.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";
import { installManifestPath } from "../cli/lib/helpers.mjs";
import { applyInstall, makeTarget, planInstall, readPointer, shortHash, writePointer } from "../cli/lib/generations.mjs";

const N = process.env.OPENCADRE_HEAVY_TESTS === "1" ? 200 : 20;

/** The probe closure for generation `tag`: entry -> config (static), then clients (dynamic, after `pauseMs`). */
const probe = (tag: string, pauseMs = 40) => ({
  "opencadre-usage.mjs": [
    `import { existsSync } from "node:fs";`,
    `import { GEN as C } from "./opencadre-config.mjs";`,
    `const GEN = ${JSON.stringify(tag)};`,
    `if (process.env.GO_FILE) { process.stdout.write("started " + JSON.stringify({ entry: GEN, config: C, pid: process.pid, marker: process.env.GO_FILE }) + "\\n"); while (!existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 20)); }`,
    `else await new Promise((r) => setTimeout(r, ${pauseMs}));`,
    `const D = (await import("./opencadre-clients.mjs")).GEN;`,
    `process.stdout.write(JSON.stringify({ entry: GEN, config: C, clients: D }) + "\\n");`,
    ``,
  ].join("\n"),
  "opencadre-config.mjs": `export const GEN = ${JSON.stringify(tag)};\n`,
  "opencadre-clients.mjs": `export const GEN = ${JSON.stringify(tag)};\n`,
});

type Run = { code: number | null; out: string; err: string; closed: boolean };
/** One owned child: the original lifetime timeout remains active through cleanup. A missing close is itself a failure,
 * not an unbounded Promise; file-level child-process hygiene remains the final backstop. */
function startRun(script: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, GO_FILE: "", ...env }, windowsHide: true, timeout: SPAWN_TEST_TIMEOUT_MS,
  });
  let out = "";
  let err = "";
  let closed = false;
  let failure: Error | undefined;
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.on("error", (e) => { failure = e; err += e.message; });
  const done = new Promise<Run>((resolve) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err: `${err}\nowned probe did not close within its lifetime plus cleanup bound`, closed: false });
    }, SPAWN_TEST_TIMEOUT_MS + 10_000);
    child.on("close", (code) => {
      closed = true;
      clearTimeout(deadline);
      resolve({ code, out, err, closed });
    });
  });
  return { done, pid: child.pid, out: () => out, closed: () => closed, failure: () => failure,
    cancel: () => { if (!closed) child.kill("SIGKILL"); } };
}
const run = (script: string, env: Record<string, string> = {}) => startRun(script, env).done;

/** Retained OLD count-only sampler, used ONLY by the counterexample below. Flips are not evidence of sampled cohorts. */
async function runMany(n: number, script: string, enough: () => boolean = () => true, parallel = 4): Promise<Run[]> {
  const results: Run[] = [];
  let next = 0;
  const more = () => next < n || (!enough() && next < 10 * n);
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (more()) {
      next++;
      results.push(await run(script));
    }
  }));
  return results;
}

let batchSerial = 0;
/** <=4 probes all load entry+static config, THEN the switch runs, THEN dynamic imports are released. This forces the
 * specified interleaving; it does not claim exhaustive arbitrary-scheduling/race coverage. */
async function heldBatch(dir: string, scripts: string[], tag: string, switchFiles: () => void, startupMs = 20_000, onCleanup: (runs: Run[]) => void = () => {}) {
  if (scripts.length < 1 || scripts.length > 4) throw new Error("held batch must have 1..4 probes");
  const serial = batchSerial++;
  const children = scripts.map((script, i) => {
    const go = path.join(dir, `go-${serial}-${i}`);
    return { go, ...startRun(script, { GO_FILE: go }) };
  });
  let completed = false;
  try {
    await waitFor(() => {
      let ready = 0;
      for (const c of children) {
        if (c.failure()) throw c.failure();
        if (c.closed()) throw new Error(`probe exited before release: ${c.out()}`);
        const lines = c.out().split("\n");
        if (lines.length === 1) continue; // stdout records may arrive in multiple chunks.
        if (lines.length !== 2 || lines[1] !== "" || !lines[0].startsWith("started ")) throw new Error(`invalid startup record: ${c.out()}`);
        const actual = JSON.parse(lines[0].slice("started ".length));
        expect(actual).toEqual({ entry: tag, config: tag, pid: c.pid, marker: c.go });
        ready++;
      }
      return ready === children.length;
    }, "every owned probe to load its entry and static config", startupMs);
    switchFiles();
    for (const c of children) writeFileSync(c.go, "");
    const runs = await Promise.all(children.map((c) => c.done));
    for (const r of runs) {
      expect(r.closed, r.err).toBe(true);
      expect(r.code, `${r.out} ${r.err}`).toBe(0);
      expect(r.out.trim().split("\n")).toHaveLength(2);
    }
    completed = true;
    return runs;
  } finally {
    const releaseErrors: unknown[] = [];
    for (const c of children) {
      try { writeFileSync(c.go, ""); } catch (e) { releaseErrors.push(e); }
      if (!completed || releaseErrors.length) c.cancel();
    }
    const reaped = await Promise.all(children.map((c) => c.done));
    onCleanup(reaped);
    if (releaseErrors.length || reaped.some((r) => !r.closed)) throw new AggregateError(releaseErrors, "owned probe cleanup failed");
  }
}

async function switchedRuns(dir: string, bin: string, mode: "generations" | "in-place") {
  const files = { A: probe("A"), B: probe("B") };
  const targets = { A: makeTarget({ files: files.A }), B: makeTarget({ files: files.B }) };
  const switchTo = (tag: "A" | "B") => {
    if (mode === "generations") {
      writePointer(bin, targets[tag].id);
      expect(readPointer(bin).id).toBe(targets[tag].id);
    } else for (const [name, text] of Object.entries(files[tag])) writeFileSync(path.join(bin, name), text);
  };
  if (mode === "generations") {
    for (const target of Object.values(targets)) applyInstall(bin, planInstall(bin, { target }));
  } else mkdirSync(bin, { recursive: true });
  const runs: Run[] = [];
  let switches = 0;
  for (let offset = 0; offset < N; offset += 4) {
    const before = (offset / 4) % 2 === 0 ? "A" : "B";
    const after = before === "A" ? "B" : "A";
    switchTo(before);
    const batch = await heldBatch(dir, Array.from({ length: Math.min(4, N - offset) }, () => path.join(bin, "opencadre-usage.mjs")), before, () => {
      switchTo(after);
      switches++;
    });
    for (const r of batch) expect(ids(r)).toEqual(mode === "generations" ? [before, before, before] : [before, before, after]);
    runs.push(...batch);
  }
  return { runs, switches };
}

const ids = (r: Run) => {
  const line = r.out.trim().split("\n").pop() ?? "";
  try {
    const j = JSON.parse(line);
    return [j.entry, j.config, j.clients];
  } catch {
    return null;
  }
};

describe("falsifier 8: hook runs across a generation switch each see ONE generation", () => {
  // Mutant: the switch rewriting the ACTIVE generation's files in place (writePointer copying the target tree over the
  // tree the pointer names, the pre-PR-2 E3 behaviour) instead of renaming the pointer -> mixed runs, red. The control
  // arm below shows independently that this instrument sees mixing when files are rewritten in place.
  it(`${N} runs through the stub while the pointer flips A<->B: every run's closure is one id, and both ids are seen`, async () => {
    const dir = tmpDir("oc-gen-flip-");
    const bin = path.join(dir, ".opencadre", "bin");
    const { runs, switches: flips } = await switchedRuns(dir, bin, "generations");
    expect(runs).toHaveLength(N);
    const bad = runs.filter((r) => { const x = ids(r); return !x || new Set(x).size !== 1; });
    expect(bad.map((r) => `${r.code} ${r.out} ${r.err}`)).toEqual([]);
    expect(flips).toBeGreaterThan(2);
    // The instrument must have been able to disagree: runs landed on both sides of the switch.
    expect(new Set(runs.map((r) => ids(r)![0]))).toEqual(new Set(["A", "B"]));
  }, 240_000);

  it("CONTROL: the same runs against files rewritten in place (the old upgrade) DO see mixed closures", async () => {
    const dir = tmpDir("oc-gen-inplace-");
    const bin = path.join(dir, "bin");
    const { runs } = await switchedRuns(dir, bin, "in-place");
    expect(runs).toHaveLength(N);
    const mixedOrBroken = runs.filter((r) => { const x = ids(r); return !x || new Set(x).size !== 1; });
    expect(mixedOrBroken.length).toBeGreaterThan(0);
  }, 240_000);

  it("COUNTEREXAMPLE: six completed switches do not establish both sampled cohorts", async () => {
    const dir = tmpDir("oc-gen-count-counterexample-");
    const bin = path.join(dir, "bin");
    const targets = { A: makeTarget({ files: probe("A") }), B: makeTarget({ files: probe("B") }) };
    for (const target of Object.values(targets)) applyInstall(bin, planInstall(bin, { target }));
    let flips = 0;
    for (const tag of ["A", "B", "A", "B", "A", "B"] as const) { writePointer(bin, targets[tag].id); flips++; }
    const runs = await runMany(N, path.join(bin, "opencadre-usage.mjs"), () => flips >= 6);
    expect(runs).toHaveLength(N);
    for (const r of runs) { expect(r.code, r.err).toBe(0); expect(ids(r)).toEqual(["B", "B", "B"]); }
    expect(flips).toBeGreaterThan(2);
    expect(new Set(runs.map((r) => ids(r)![0]))).not.toEqual(new Set(["A", "B"]));
  }, 240_000);

  it("a failed startup or switch closes/releases every owned probe", async () => {
    const dir = tmpDir("oc-gen-barrier-cleanup-");
    const good = path.join(dir, "opencadre-usage.mjs");
    for (const [name, text] of Object.entries(probe("A"))) writeFileSync(path.join(dir, name), text);
    const missing = path.join(dir, "missing.mjs");
    let switched = false;
    let reaped: Run[] = [];
    const capture = (runs: Run[]) => { reaped = runs; };
    const checkCleanup = () => { expect(reaped).toHaveLength(2); expect(reaped.every((r) => r.closed)).toBe(true); };
    await expect(heldBatch(dir, [good, missing], "A", () => { switched = true; }, 20_000, capture)).rejects.toThrow("probe exited before release");
    expect(switched).toBe(false);
    checkCleanup();
    await expect(heldBatch(dir, [good, good], "A", () => { throw new Error("forced switch failure"); }, 20_000, capture)).rejects.toThrow("forced switch failure");
    checkCleanup();
    const silent = path.join(dir, "silent.mjs");
    writeFileSync(silent, `import { existsSync } from "node:fs"; while (!existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 20));`);
    await expect(heldBatch(dir, [good, silent], "A", () => { switched = true; }, 100, capture)).rejects.toThrow("timed out after 100 ms");
    expect(switched).toBe(false);
    checkCleanup();
    expect((await heldBatch(dir, [good, good], "A", () => {})).every((r) => r.closed && r.code === 0)).toBe(true);
  }, 60_000);

  it("valid closure output with a failing exit is rejected, not accepted as control evidence", async () => {
    const dir = tmpDir("oc-gen-invalid-exit-");
    const files = probe("A");
    files["opencadre-usage.mjs"] += "process.exitCode = 7;\n";
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    let reaped: Run[] = [];
    await expect(heldBatch(dir, [path.join(dir, "opencadre-usage.mjs")], "A", () => {}, 20_000, (runs) => { reaped = runs; })).rejects.toThrow();
    expect(reaped).toHaveLength(1);
    expect(reaped[0].closed).toBe(true);
    expect(reaped[0].code).toBe(7);
    expect(ids(reaped[0])).toEqual(["A", "A", "A"]);
  }, 60_000);
});

describe("falsifier 11: legacy conversion never gives one run a mixed closure", () => {
  // Mutant: conversion ALSO rewriting the legacy root library files (so an old entry's later import finds new code)
  // -> the old run reports a NEW library under an OLD entry, red.
  it("an old fixed-file entry loaded during conversion finishes on OLD files; a stub run afterwards is all NEW", async () => {
    const dir = tmpDir("oc-gen-convert-");
    const bin = path.join(dir, ".opencadre", "bin");
    mkdirSync(bin, { recursive: true });
    const old = probe("OLD");
    for (const [name, text] of Object.entries(old)) writeFileSync(path.join(bin, name), text);
    // The pre-generation manifest recorded these files, so conversion treats them as stale official ones.
    writeFileSync(installManifestPath(bin), JSON.stringify({ cliVersion: "0.1.0", stamp: "000000000000", installedAt: "2026-09-01T00:00:00Z", helpers: Object.fromEntries(Object.entries(old).map(([n, t]) => [n, shortHash(t)])) }));
    const go = path.join(dir, "go");
    const oldRun = spawn(process.execPath, [path.join(bin, "opencadre-usage.mjs")], { env: { ...process.env, GO_FILE: go } });
    let out = "";
    oldRun.stdout.on("data", (c) => (out += c));
    const closed = new Promise<number | null>((resolve) => oldRun.on("close", resolve));
    await waitFor(() => out.includes("started"), "the old entry to load");

    const target = makeTarget({ files: probe("NEW") });
    const plan = planInstall(bin, { target });
    expect(plan.converting).toBe(true);
    applyInstall(bin, plan);
    expect(readPointer(bin).id).toBe(target.id);
    // The legacy libraries are byte-identical: conversion writes stubs over ENTRIES only.
    expect(readFileSync(path.join(bin, "opencadre-config.mjs"), "utf8")).toBe(old["opencadre-config.mjs"]);
    expect(readFileSync(path.join(bin, "opencadre-clients.mjs"), "utf8")).toBe(old["opencadre-clients.mjs"]);

    writeFileSync(go, "");
    expect(await closed).toBe(0);
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ entry: "OLD", config: "OLD", clients: "OLD" });
    const fresh = await run(path.join(bin, "opencadre-usage.mjs"));
    expect(ids(fresh), fresh.err).toEqual(["NEW", "NEW", "NEW"]);
    expect(existsSync(path.join(bin, ".gen", target.id))).toBe(true);
  }, 60_000);
});
