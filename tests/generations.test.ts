// Atomic, generation-pinned installs (cli/lib/generations.mjs; Q1g PR-2, plan §2.B-C and §2.D falsifiers 2, 3, 7, 9, 10,
// and 049a's §2b-1 "no pruning"). Each describe names the falsifier it is; each can fail (the mutant that turns it red
// is named beside it).
import { describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers/tmp.js";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";
import { ENTRIES, HELPERS, installedText, installManifestPath, readInstallManifest } from "../cli/lib/helpers.mjs";
import { stubText } from "../cli/lib/stubs.mjs";
import {
  applyInstall, BACKUP, classify, cliBuild, generationPath, installHelpers, installState, InstallError, makeTarget, planInstall, readPointer, shortHash, upgradeHelpers, verifyTree, writePointer,
} from "../cli/lib/generations.mjs";

// Each test installs whole generations (tens of files, fsynced); on a shared, loaded box that outlasts the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const GENERATIONS = pathToFileURL(path.join(process.cwd(), "cli", "lib", "generations.mjs")).href;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const newBin = (prefix = "oc-gen-") => path.join(tmpDir(prefix), ".opencadre", "bin");
const read = (f: string) => readFileSync(f, "utf8");

/** Every file under `dir` (recursively) -> its bytes' sha256, for "byte-identical" comparisons. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = sha(readFileSync(path.join(dir, r), "latin1"));
    }
  };
  if (existsSync(dir)) walk("");
  return out;
}

/** A small generation of our own making: an entry and two libraries, each exporting which generation it is. */
function probeFiles(tag: string, extra: Record<string, string> = {}) {
  return {
    "opencadre-usage.mjs": `import { GEN as C } from "./opencadre-config.mjs";\nexport const GEN = ${JSON.stringify(tag)};\nconst D = (await import("./opencadre-clients.mjs")).GEN;\nprocess.stdout.write(JSON.stringify({ entry: GEN, config: C, clients: D }));\n`,
    "opencadre-config.mjs": `export const GEN = ${JSON.stringify(tag)};\n`,
    "opencadre-clients.mjs": `export const GEN = ${JSON.stringify(tag)};\n`,
    ...extra,
  };
}

describe("layout: one immutable tree per generation, a pointer, stable stubs", () => {
  it("installs every helper into .gen/<id>/, points current at it, and writes a stub at every entry path", () => {
    const bin = newBin();
    installHelpers(bin);
    const build = cliBuild();
    expect(readPointer(bin)).toEqual({ id: build.id, problem: null });
    for (const name of Object.keys(HELPERS)) expect(read(path.join(generationPath(bin, build.id), ...name.split("/"))), name).toBe(installedText(name));
    for (const name of Object.keys(ENTRIES)) expect(read(path.join(bin, ...name.split("/"))), name).toBe(stubText(name, installedText(name)));
    const manifest = readInstallManifest(bin)!;
    expect(manifest).toMatchObject({ layout: "generations", generation: build.id, activated: [build.id] });
    expect(verifyTree(generationPath(bin, build.id), build.helpers, build.imports)).toEqual([]);
    expect(installState(bin).state).toBe("current");
  });

  it("helpers.mjs imports only node builtins (provenanceFor loads it alone from a scratch folder)", () => {
    const text = read(path.join(process.cwd(), "cli", "lib", "helpers.mjs"));
    const specs = [...text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  it("a pointer write is one rename: current always holds a whole id", () => {
    const bin = newBin();
    mkdirSync(path.join(bin, ".gen"), { recursive: true });
    writePointer(bin, "aaaaaaaaaaaa");
    writePointer(bin, "bbbbbbbbbbbb");
    expect(read(path.join(bin, ".gen", "current"))).toBe("bbbbbbbbbbbb\n");
    expect(readdirSync(path.join(bin, ".gen"))).toEqual(["current"]);
    writeFileSync(path.join(bin, ".gen", "current"), "nope");
    expect(readPointer(bin)).toEqual({ id: null, problem: "malformed" });
  });
});

describe("falsifier 2 (E2): an untracked file of a KNOWN official revision is refreshed, never called edited", () => {
  // Mutant: classify() treating "not in the manifest" as edited (the E2 line, `previous.helpers[name] !== hash`) -> red.
    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("a legacy install whose manifest predates some helpers: official-old files refresh, none is refused", () => {
    // Real history: an older committed revision of the gate and of pure-ack, as the in-place installer wrote them.
    const older = (repoPath: string) => {
      const shas = spawnSync("git", ["log", "--format=%H", "--", repoPath], { encoding: "utf8" }).stdout.trim().split("\n");
      expect(shas.length, `${repoPath} needs history`).toBeGreaterThan(1);
      return spawnSync("git", ["show", `${shas[1]}:${repoPath}`], { encoding: "utf8" }).stdout.replaceAll("../../scripts/", "./");
    };
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    const gateOld = older(HELPERS["opencadre-approval-gate.mjs"]);
    const ackOld = older(HELPERS["pure-ack.mjs"]);
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), gateOld);
    writeFileSync(path.join(bin, "pure-ack.mjs"), ackOld);
    // An old manifest that never listed these two (installed before they existed in its HELPERS).
    writeFileSync(installManifestPath(bin), JSON.stringify({ cliVersion: "0.1.0", stamp: "000000000000", installedAt: "2026-09-01T00:00:00Z", helpers: { "opencadre-mcp.mjs": "111111111111" } }));
    const plan = planInstall(bin);
    expect(plan.slots.find((s) => s.name === "opencadre-approval-gate.mjs")!.cls).toBe("official-old");
    expect(plan.libraries.find((l) => l.name === "pure-ack.mjs")!.cls).toBe("official-old");
    const result = upgradeHelpers(bin);
    expect(result.refused).toEqual([]);
    expect(result.changed).toEqual(expect.arrayContaining(["opencadre-approval-gate.mjs", "pure-ack.mjs"]));
    expect(read(path.join(bin, "opencadre-approval-gate.mjs"))).toBe(stubText("opencadre-approval-gate.mjs", installedText("opencadre-approval-gate.mjs")));
    // The legacy LIBRARY is left exactly as it was (an old entry may still import it); the generation holds the new one.
    expect(read(path.join(bin, "pure-ack.mjs"))).toBe(ackOld);
    expect(read(path.join(generationPath(bin, result.id), "pure-ack.mjs"))).toBe(installedText("pure-ack.mjs"));
  }, 60_000);

  it("classify, row by row (plan §C)", () => {
    const history = { x: [sha("old official")] };
    const legacy = { stamp: "s", helpers: { x: shortHash("recorded") } };
    expect(classify({ name: "x", disk: null, want: "t", previous: null, history })).toBe("missing");
    expect(classify({ name: "x", disk: "t", want: "t", previous: null, history })).toBe("current");
    expect(classify({ name: "x", disk: "recorded", want: "t", previous: legacy, history })).toBe("stale");
    expect(classify({ name: "x", disk: "old official", want: "t", previous: null, history })).toBe("official-old");
    expect(classify({ name: "x", disk: "mine", want: "t", previous: null, history })).toBe("unknown");
    expect(classify({ name: "x", disk: "changed", want: "t", previous: legacy, history })).toBe("edited");
    // CRLF: PR-1's history carries both renderings of each revision, so a CRLF checkout's copy is known too.
    expect(classify({ name: "x", disk: "old official", want: "t", previous: { stamp: "s", helpers: {} }, history })).toBe("official-old");
  });
});

describe("falsifier 3: an unknown untracked file is refused and listed; --force backs it up durably, then replaces it", () => {
  // Mutants: (a) classify() calling an unknown hash official -> the refusal assertion is red; (b) applyInstall skipping
  // the backup write -> the backup assertion is red.
  it("refuses, lists and preserves it byte for byte; --force copies it to .backup/<ts>/ first", () => {
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    const mine = "// my own gate, from nowhere OpenCadre knows\nprocess.exit(0);\n";
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), mine);
    const plain = upgradeHelpers(bin);
    expect(plain.refused).toEqual(["opencadre-approval-gate.mjs"]);
    expect(read(path.join(bin, "opencadre-approval-gate.mjs"))).toBe(mine);
    expect(readInstallManifest(bin)!.refused).toEqual({ "opencadre-approval-gate.mjs": "unknown" });
    // Still refused on the next run: the manifest does not adopt a file it refused.
    expect(upgradeHelpers(bin).refused).toEqual(["opencadre-approval-gate.mjs"]);
    const forced = upgradeHelpers(bin, { force: true });
    expect(forced.refused).toEqual([]);
    expect(forced.backups).toHaveLength(1);
    expect(forced.backups[0]).toContain(path.join(bin, BACKUP));
    expect(read(forced.backups[0])).toBe(mine);
    expect(read(path.join(bin, "opencadre-approval-gate.mjs"))).toBe(stubText("opencadre-approval-gate.mjs", installedText("opencadre-approval-gate.mjs")));
    expect(readInstallManifest(bin)!.refused).toEqual({});
  }, 60_000);

  it("an edited stub (recorded, then changed) is refused as edited", () => {
    const bin = newBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-wake.mjs"), "// tuned\n");
    expect(upgradeHelpers(bin).refused).toEqual(["opencadre-wake.mjs"]);
    expect(readInstallManifest(bin)!.refused).toEqual({ "opencadre-wake.mjs": "edited" });
    expect(installState(bin).state).toBe("modified");
  });

  it("a refused legacy entry that imports a slot the switch moves to the new generation blocks the WHOLE switch (exit 2, names the pair)", () => {
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    const loader = "// my loader\nawait import(\"./opencadre-approval-gate.mjs\");\n";
    writeFileSync(path.join(bin, "opencadre-approval-gate-loader.mjs"), loader);
    const before = snapshot(bin);
    let err: unknown;
    try {
      upgradeHelpers(bin);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstanceType<typeof InstallError>).exitCode).toBe(2);
    expect((err as Error).message).toContain("opencadre-approval-gate-loader.mjs (left as it is) imports opencadre-approval-gate.mjs");
    expect(snapshot(bin)).toEqual(before);
    // --force backs the loader up and replaces it, so nothing old imports anything new.
    expect(upgradeHelpers(bin, { force: true }).backups).toHaveLength(1);
  });
});

// Production 480c850e (2026-10-06) served its CLI with provenance "none": every helper's officialHistory was []. An
// upgrade in that window refused every untracked official old helper as "unknown" and recorded the refusal, which then
// stuck on every later upgrade. A hash in officialHistory is by definition bytes OpenCadre shipped, so a slot refused
// as "unknown" is re-checked against the CURRENT target's history; "edited" stays refused (the user changed a file
// OpenCadre had recorded, whatever its bytes now are).
describe("a slot refused as \"unknown\" recovers once the target's official history proves its bytes", () => {
  // Mutant: classify() returning a previous "unknown" refusal without re-checking it against the history -> the
  // refresh test below is red (its slot stays refused, the manifest keeps the refusal).
  const GATE = "opencadre-approval-gate.mjs";
  const currentFiles = () => Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)]));
  /** The production window's build: this CLI's own helpers, but an empty official history for every one. */
  const emptyHistoryTarget = () => makeTarget({ files: currentFiles(), history: Object.fromEntries(Object.keys(HELPERS).map((n) => [n, []])) });
  /** An older committed revision of a helper, as the in-place installer wrote it (the falsifier 2 fixture). */
  const olderOfficial = (name: string) => {
    const repoPath = HELPERS[name as keyof typeof HELPERS];
    const shas = spawnSync("git", ["log", "--format=%H", "--", repoPath], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(shas.length, `${repoPath} needs history`).toBeGreaterThan(1);
    return spawnSync("git", ["show", `${shas[1]}:${repoPath}`], { encoding: "utf8" }).stdout.replaceAll("../../scripts/", "./");
  };
  const slot = (bin: string) => path.join(bin, GATE);

  it("classify, row by row: a previous refusal and the history", () => {
    const history = { x: [sha("old official")] };
    const refusedUnknown = (disk: string) => ({ layout: "generations", slots: { x: shortHash(disk) }, refused: { x: "unknown" } });
    // Proven by the history: official-old, whatever the earlier refusal said.
    expect(classify({ name: "x", disk: "old official", want: "t", previous: refusedUnknown("old official"), history })).toBe("official-old");
    // Not proven: still unknown. In particular the recorded hash of the refused bytes never reads as "stale".
    expect(classify({ name: "x", disk: "mine", want: "t", previous: refusedUnknown("mine"), history })).toBe("unknown");
    expect(classify({ name: "x", disk: "old official", want: "t", previous: refusedUnknown("old official"), history: null })).toBe("unknown");
    expect(classify({ name: "x", disk: "old official", want: "t", previous: refusedUnknown("old official"), history: { x: [] } })).toBe("unknown");
    // "edited" is sticky even when its bytes are an official revision.
    const refusedEdited = { layout: "generations", slots: { x: shortHash("recorded") }, refused: { x: "edited" } };
    expect(classify({ name: "x", disk: "old official", want: "t", previous: refusedEdited, history })).toBe("edited");
    // Equal to the target is current, refused or not (unchanged).
    expect(classify({ name: "x", disk: "t", want: "t", previous: refusedUnknown("old official"), history })).toBe("current");
  });

    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("an official old helper refused under an EMPTY history is refreshed by the next upgrade whose history holds its hash", () => {
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    const gateOld = olderOfficial(GATE);
    writeFileSync(slot(bin), gateOld);
    // The window: refused as unknown, preserved, and the refusal recorded.
    const window = upgradeHelpers(bin, { target: emptyHistoryTarget() });
    expect(window.refused).toEqual([GATE]);
    expect(read(slot(bin))).toBe(gateOld);
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "unknown" });
    // Known positive: the restored history (this checkout's, from git) really holds those bytes.
    expect(cliBuild().history()?.[GATE]).toContain(sha(gateOld));
    expect(planInstall(bin).slots.find((s) => s.name === GATE)!.cls).toBe("official-old");
    const result = upgradeHelpers(bin);
    expect(result.refused).toEqual([]);
    expect(result.backups).toEqual([]);
    expect(read(slot(bin))).toBe(stubText(GATE, installedText(GATE)));
    // Cleared through the normal success path: the manifest records the stub, and no refusal.
    expect(readInstallManifest(bin)!.refused).toEqual({});
    expect(readInstallManifest(bin)!.slots[GATE]).toBe(shortHash(stubText(GATE, installedText(GATE))));
    expect(installState(bin).state).toBe("current");
  });

  it("a slot refused as unknown whose hash is NOT in the history stays refused, preserved byte for byte; --force still backs it up first", () => {
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    const mine = "// my own gate, from nowhere OpenCadre knows\nprocess.exit(0);\n";
    writeFileSync(slot(bin), mine);
    expect(upgradeHelpers(bin, { target: emptyHistoryTarget() }).refused).toEqual([GATE]);
    const again = upgradeHelpers(bin);
    expect(again.refused).toEqual([GATE]);
    expect(read(slot(bin))).toBe(mine);
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "unknown" });
    const forced = upgradeHelpers(bin, { force: true });
    expect(forced.refused).toEqual([]);
    expect(forced.backups.map((f: string) => read(f))).toEqual([mine]);
    expect(readInstallManifest(bin)!.refused).toEqual({});
  });

    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("a slot refused as edited stays refused even when its bytes are an official revision; --force still backs it up first", () => {
    const bin = newBin();
    installHelpers(bin);
    const gateOld = olderOfficial(GATE);
    writeFileSync(slot(bin), gateOld);
    expect(upgradeHelpers(bin).refused).toEqual([GATE]);
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "edited" });
    expect(cliBuild().history()?.[GATE]).toContain(sha(gateOld));
    const again = upgradeHelpers(bin);
    expect(again.refused).toEqual([GATE]);
    expect(read(slot(bin))).toBe(gateOld);
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "edited" });
    const forced = upgradeHelpers(bin, { force: true });
    expect(forced.refused).toEqual([]);
    expect(forced.backups.map((f: string) => read(f))).toEqual([gateOld]);
    expect(read(slot(bin))).toBe(stubText(GATE, installedText(GATE)));
  });

  it("the history is still read only when a slot needs it: a refused \"edited\" slot or a clean install never reads it", () => {
    const bin = newBin();
    installHelpers(bin);
    let reads = 0;
    const counted = () => makeTarget({ files: currentFiles(), history: () => (reads++, {}) });
    planInstall(bin, { target: counted() });
    expect(reads).toBe(0);
    writeFileSync(slot(bin), "// tuned\n");
    upgradeHelpers(bin, { target: counted() });
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "edited" });
    reads = 0;
    planInstall(bin, { target: counted() });
    expect(reads).toBe(0);
  });
});

describe("falsifiers 9 and 10: no success manifest before the verified generation is active; a failure rolls back", () => {
  const install = (bin: string, tag: string) => applyInstall(bin, planInstall(bin, { target: makeTarget({ files: probeFiles(tag) }) }));

  // Mutant: writing the manifest before the pointer flip (or before validation) -> the step observer is red.
  it("the manifest does not change until the pointer names the verified generation", () => {
    const bin = newBin();
    install(bin, "A");
    const oldManifest = read(installManifestPath(bin));
    const target = makeTarget({ files: probeFiles("B") });
    const seen: string[] = [];
    applyInstall(bin, planInstall(bin, { target }), {
      onStep: (step: string) => {
        seen.push(step);
        const pointerIsB = readPointer(bin).id === target.id;
        if (step !== "manifest") expect(read(installManifestPath(bin)), `manifest at ${step}`).toBe(oldManifest);
        if (step === "manifest") expect(pointerIsB).toBe(true);
      },
    });
    expect(seen).toEqual(["staged", "validated", "renamed", "pointer-tmp", "pointer", "stubs", "manifest"]);
    expect(readInstallManifest(bin)!.generation).toBe(target.id);
  });

  // Mutant: dropping the `finally` that removes the staging folder -> the "no staging left" assertion is red.
  it("a validation failure after staging leaves current, the old generation and the manifest byte-identical, and removes staging", () => {
    const bin = newBin();
    install(bin, "A");
    const before = snapshot(bin);
    const target = makeTarget({ files: probeFiles("B") });
    expect(() => applyInstall(bin, planInstall(bin, { target }), {
      // Fault injection: a staged file is not what the target says it is.
      onStep: (step: string, info: { staging: string }) => {
        if (step === "staged") writeFileSync(path.join(info.staging, "opencadre-config.mjs"), "export const GEN = 'tampered';\n");
      },
    })).toThrow(/did not verify/);
    expect(snapshot(bin)).toEqual(before);
    expect(readdirSync(path.join(bin, ".gen")).filter((f) => f.startsWith(".staging-"))).toEqual([]);
    expect(existsSync(generationPath(bin, target.id))).toBe(false);
  });

  it("a hub manifest that disagrees with the CLI's own files fails verification the same way", () => {
    const bin = newBin();
    const target = makeTarget({ files: probeFiles("A") });
    const hub = { ...target.helpers, "opencadre-config.mjs": sha("something else") };
    expect(() => applyInstall(bin, planInstall(bin, { target }), { verifyHelpers: hub })).toThrow(/did not verify/);
    expect(readPointer(bin).id).toBeNull();
    expect(existsSync(installManifestPath(bin))).toBe(false);
  });
});

describe("falsifier 7: an upgrade killed at any step leaves current naming the old, complete generation, and doctor says partial", () => {
  // Mutants: (a) writing the pointer before the directory rename -> "current names A" is red at "staged"; (b) installState
  // ignoring never-activated generations -> "partial" is red at "renamed"; (c) ignoring leftovers -> red at "staged".
  const crashScript = (dir: string) => {
    const file = path.join(dir, "crash-at.mjs");
    writeFileSync(file, `
const { applyInstall, makeTarget, planInstall } = await import(${JSON.stringify(GENERATIONS)});
const [bin, filesJson, at] = process.argv.slice(2);
const target = makeTarget({ files: JSON.parse(await (await import("node:fs")).promises.readFile(filesJson, "utf8")) });
applyInstall(bin, planInstall(bin, { target }), { onStep: (step) => { if (step === at) process.exit(99); } });
process.exit(0);
`);
    return file;
  };

  for (const at of ["staged", "renamed", "pointer-tmp"]) {
    it(`killed after "${at}"`, () => {
      const dir = tmpDir("oc-gen-crash-");
      const bin = path.join(dir, ".opencadre", "bin");
      const a = makeTarget({ files: probeFiles("A") });
      applyInstall(bin, planInstall(bin, { target: a }));
      const aTree = snapshot(generationPath(bin, a.id));
      const filesJson = path.join(dir, "b.json");
      writeFileSync(filesJson, JSON.stringify(probeFiles("B")));
      const r = spawnSync(process.execPath, [crashScript(dir), bin, filesJson, at], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(99);
      expect(readPointer(bin).id).toBe(a.id);
      expect(snapshot(generationPath(bin, a.id))).toEqual(aTree);
      expect(verifyTree(generationPath(bin, a.id), a.helpers, a.imports)).toEqual([]);
      expect(readInstallManifest(bin)!.generation).toBe(a.id);
      const state = installState(bin, { target: a });
      expect(state.state).toBe("partial");
      // The next run cleans up the interrupted run's leftovers and completes.
      const b = makeTarget({ files: probeFiles("B") });
      applyInstall(bin, planInstall(bin, { target: b }));
      expect(readPointer(bin).id).toBe(b.id);
      expect(installState(bin, { target: b }).state).toBe("current");
    }, SPAWN_TEST_TIMEOUT_MS);
  }

  it("killed after the pointer flip but before the manifest: doctor says partial (pointer and manifest disagree)", () => {
    const dir = tmpDir("oc-gen-crash-");
    const bin = path.join(dir, ".opencadre", "bin");
    applyInstall(bin, planInstall(bin, { target: makeTarget({ files: probeFiles("A") }) }));
    const filesJson = path.join(dir, "b.json");
    writeFileSync(filesJson, JSON.stringify(probeFiles("B")));
    const r = spawnSync(process.execPath, [crashScript(dir), bin, filesJson, "pointer"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(99);
    const b = makeTarget({ files: probeFiles("B") });
    const state = installState(bin, { target: b });
    expect(state.state).toBe("partial");
    expect(state.reasons.join(" ")).toContain("did not finish");
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("049a §2b-1: no generation is pruned, so an old consumer can still start its own generation's files", () => {
  // Mutant: pruning every generation the pointer no longer names at the end of applyInstall -> the old consumer's
  // spawn of its own wake fails, and this is red.
  it("A -> B -> C while a consumer started on A later spawns its wake: it runs A's whole closure", async () => {
    const dir = tmpDir("oc-gen-old-consumer-");
    const bin = path.join(dir, ".opencadre", "bin");
    const go = path.join(dir, "go");
    const files = (tag: string) => ({
      // The consumer: loaded through the awareness stub, it waits, then starts its SIBLING wake (as the real awareness
      // hook does, by `new URL("./opencadre-wake.mjs", import.meta.url)`).
      "opencadre-awareness.mjs": `import { spawnSync } from "node:child_process";\nimport { existsSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nexport const GEN = ${JSON.stringify(tag)};\nprocess.stdout.write("started\\n");\nwhile (!existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 20));\nconst child = spawnSync(process.execPath, [fileURLToPath(new URL("./opencadre-wake.mjs", import.meta.url))], { encoding: "utf8" });\nprocess.stdout.write(JSON.stringify({ self: GEN, child: child.stdout, status: child.status }) + "\\n");\n`,
      "opencadre-wake.mjs": `import { GEN as C } from "./opencadre-config.mjs";\nprocess.stdout.write(JSON.stringify({ wake: ${JSON.stringify(tag)}, config: C }));\n`,
      "opencadre-config.mjs": `export const GEN = ${JSON.stringify(tag)};\n`,
    });
    const A = makeTarget({ files: files("A") });
    applyInstall(bin, planInstall(bin, { target: A }));
    const consumer = spawn(process.execPath, [path.join(bin, "opencadre-awareness.mjs")], { env: { ...process.env, GO_FILE: go } });
    let out = "";
    consumer.stdout.on("data", (c) => (out += c));
    const closed = new Promise<number | null>((resolve) => consumer.on("close", resolve));
    await waitFor(() => out.includes("started"), "the consumer to load generation A");
    applyInstall(bin, planInstall(bin, { target: makeTarget({ files: files("B") }) }));
    const C = makeTarget({ files: files("C") });
    applyInstall(bin, planInstall(bin, { target: C }));
    expect(readPointer(bin).id).toBe(C.id);
    writeFileSync(go, "");
    expect(await closed).toBe(0);
    const report = JSON.parse(out.trim().split("\n").pop()!);
    expect(report.self).toBe("A");
    expect(report.status).toBe(0);
    expect(JSON.parse(report.child)).toEqual({ wake: "A", config: "A" });
    // All three generations are still there.
    expect(readdirSync(path.join(bin, ".gen")).filter((f) => /^[0-9a-f]{12}$/.test(f))).toHaveLength(3);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("installState (doctor): exactly one of current / stale / partial / modified", () => {
  it("names each state for its cause", () => {
    const bin = newBin();
    expect(installState(bin).state).toBe("missing");
    installHelpers(bin);
    expect(installState(bin).state).toBe("current");
    // Stale: the active generation is not what the reference (e.g. the hub's manifest) says.
    const other = { helpers: { ...cliBuild().helpers, "opencadre-config.mjs": sha("hub's newer config") }, imports: cliBuild().imports };
    const stale = installState(bin, { expected: other });
    expect(stale.state).toBe("stale");
    expect(stale.gate.find((g: { name: string }) => g.name === "opencadre-config.mjs")).toMatchObject({ ok: false });
    // Partial outranks everything: a staging folder left behind.
    mkdirSync(path.join(bin, ".gen", ".staging-1-deadbeef"));
    expect(installState(bin).state).toBe("partial");
  });

  it("a legacy (pre-generation) install is stale, never current", () => {
    const bin = newBin();
    mkdirSync(bin, { recursive: true });
    for (const name of Object.keys(HELPERS)) {
      mkdirSync(path.dirname(path.join(bin, ...name.split("/"))), { recursive: true });
      writeFileSync(path.join(bin, ...name.split("/")), installedText(name));
    }
    expect(installState(bin).state).toBe("stale");
  });
});

describe("independent review: concurrent writers and the actual gate entry", () => {
  for (const at of ["staged", "pointer-tmp"]) {
    it(`refuses an overlapping installer at ${at} before it touches the owner's files`, () => {
      const bin = newBin();
      const old = makeTarget({ files: probeFiles("OLD") });
      const a = makeTarget({ files: probeFiles("A") });
      applyInstall(bin, planInstall(bin, { target: old }));
      const contender = path.join(tmpDir("oc-gen-contender-"), "run.mjs");
      writeFileSync(contender, `const {applyInstall,planInstall,makeTarget}=await import(${JSON.stringify(GENERATIONS)}); const target=makeTarget({files:${JSON.stringify(probeFiles("B"))}}); try{applyInstall(${JSON.stringify(bin)},planInstall(${JSON.stringify(bin)},{target}));}catch(e){console.error(e.message);process.exit(e.exitCode??1);}`);
      let checked = false;
      applyInstall(bin, planInstall(bin, { target: a }), { onStep: (step: string) => {
        if (step !== at) return;
        const before = snapshot(bin);
        const peer = spawnSync(process.execPath, [contender], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        expect(peer.status, peer.stderr).toBe(2);
        expect(peer.stderr).toMatch(/another installer/i);
        expect(snapshot(bin)).toEqual(before);
        checked = true;
      } });
      expect(checked).toBe(true);
      expect(readPointer(bin).id).toBe(a.id);
      expect(installState(bin, { target: a }).state).toBe("current");
    });
  }

  it("rejects a plan made before another completed upgrade and preserves that upgrade", () => {
    const bin = newBin();
    const old = makeTarget({ files: probeFiles("OLD") });
    const a = makeTarget({ files: probeFiles("A") });
    const b = makeTarget({ files: probeFiles("B") });
    applyInstall(bin, planInstall(bin, { target: old }));
    const pending = planInstall(bin, { target: a });
    applyInstall(bin, planInstall(bin, { target: b }));
    const before = snapshot(bin);
    expect(() => applyInstall(bin, pending)).toThrow(/changed.*plan/i);
    expect(snapshot(bin)).toEqual(before);
    expect(installState(bin, { target: b }).state).toBe("current");
    applyInstall(bin, planInstall(bin, { target: a }));
    expect(installState(bin, { target: a }).state).toBe("current");
    expect(readInstallManifest(bin)!.activated).toContain(b.id);
  });

  it("rejects a saved force plan after a new local edit, then backs up current bytes on a fresh force plan", () => {
    const bin = newBin();
    installHelpers(bin);
    const pending = planInstall(bin, { force: true });
    const edit = "// operator's later edit\nprocess.exit(0);\n";
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), edit);
    const before = snapshot(bin);
    expect(() => applyInstall(bin, pending)).toThrow(/changed.*plan/i);
    expect(snapshot(bin)).toEqual(before);
    const applied = applyInstall(bin, planInstall(bin, { force: true }));
    expect(applied.backups).toHaveLength(1);
    expect(read(applied.backups[0])).toBe(edit);
  });

  for (const lock of [".opencadre-install.lock", ".opencadre-install-acquire.lock"]) {
    it(`refuses unreadable ownership at ${lock} without modifying the install`, () => {
      const bin = newBin();
      const a = makeTarget({ files: probeFiles("A") });
      const b = makeTarget({ files: probeFiles("B") });
      applyInstall(bin, planInstall(bin, { target: a }));
      writeFileSync(path.join(bin, lock), "unreadable-owner");
      const before = snapshot(bin);
      expect(() => applyInstall(bin, planInstall(bin, { target: b }))).toThrow(/another installer/i);
      expect(snapshot(bin)).toEqual(before);
      expect(installState(bin, { target: a }).state).toBe("partial");
    });
  }

  it("reports the custom root gate actually invoked, even beside a complete generation", () => {
    const bin = newBin();
    installHelpers(bin);
    const custom = "process.exit(0);\n";
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), custom);
    applyInstall(bin, planInstall(bin));
    expect(read(path.join(bin, "opencadre-approval-gate.mjs"))).toBe(custom);
    const state = installState(bin);
    const gate = state.gate.find((g: {name: string}) => g.name === "opencadre-approval-gate.mjs")!;
    expect(gate.installed).toBe(sha(custom));
    expect(gate.ok).toBe(false);
  });

  it("an old OpenCode adapter denies if its pinned gate is lost after a newer generation is active", async () => {
    const home = tmpDir("oc-opencode-pinned-");
    const bin = path.join(home, ".opencadre", "bin");
    const files = Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)]));
    const gate = (tag: string, decision: string) => `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'${decision}',permissionDecisionReason:'${tag}',opencadreProvenance:'person'}}));`;
    const a = makeTarget({ files: { ...files, "opencadre-approval-gate.mjs": gate("A", "deny") } });
    applyInstall(bin, planInstall(bin, { target: a }));
    const clearance = await import(pathToFileURL(path.join(generationPath(bin, a.id), "opencode-plugin", "clearance.js")).href);
    vi.stubEnv("OPENCADRE_HOOK_HOME", home);
    try {
      const call = () => clearance.runGate({ command: "rm -rf /x", sessionID: "s1", cwd: home, nodePath: process.execPath });
      expect(await call()).toMatchObject({ decision: "deny", reason: "A" });
      const b = makeTarget({ files: { ...files, "opencadre-approval-gate.mjs": gate("B", "allow") } });
      applyInstall(bin, planInstall(bin, { target: b }));
      expect(await call()).toMatchObject({ decision: "deny", reason: "A" });
      rmSync(path.join(generationPath(bin, a.id), "opencadre-approval-gate.mjs"));
      expect(await call()).toMatchObject({ decision: "deny" });
    } finally { vi.unstubAllEnvs(); }
  }, SPAWN_TEST_TIMEOUT_MS);
});
