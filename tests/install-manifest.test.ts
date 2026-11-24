import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENTRIES, HELPERS, installedText, installManifestPath, readInstallManifest } from "../cli/lib/helpers.mjs";
import { driftLine, driftReport, generationPath, installHelpers, makeTarget, readPointer, upgradeHelpers } from "../cli/lib/generations.mjs";

// Each test installs whole generations (tens of files, fsynced); on a shared, loaded box that outlasts the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// The installed copy in ~/.opencadre/bin is what actually RUNS on a user's machine: hooks and the
// approval gate are invoked from it by absolute path. Nothing recorded which revision those copies
// came from, so a machine one repo-change behind ran a stale security control with no signal --
// measured on this PC 2026-09-18: ~/.opencadre/bin held an approval gate 230 lines behind the repo
// (the whole persistence/reprogramming-vector detection absent) and nothing reported it.
//
// This suite is about the STAMP, not the upgrade: after a connect, the install must be able to say
// which sources it came from, and must say so again identically when nothing changed.
//
// Since Q1g PR-2 the helpers live in one generation folder (bin/.gen/<id>/) behind stable entry stubs at the root
// (cli/lib/generations.mjs). The manifest's `helpers` hashes the GENERATION's files (what runs); `slots` hashes what
// sits at each entry path (the stub).

/** An install of an OLDER revision: this CLI's helpers with `name` replaced by `text`, as its own generation. */
const olderInstall = (bin: string, name: string, text: string) =>
  installHelpers(bin, { target: makeTarget({ files: { ...Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)])), [name]: text } }) });
const genFile = (bin: string, name: string) => path.join(generationPath(bin, readPointer(bin).id!), ...name.split("/"));

const tempBin = () => mkdtempSync(path.join(tmpdir(), "oc-bin-"));

/** A stable, order-independent view: the manifest's per-file map with the timestamp dropped. */
const hashesOf = (manifest: { helpers: Record<string, string> }) => manifest.helpers;

// REWRITTEN after review. The first version of this test could not fail, twice over:
//   - its second assertion compared `after.helpers[name]` with a fresh re-read of the SAME manifest,
//     so it compared a value with itself (measured: both sides 572556e24cc1);
//   - its first assertion claimed the stamp was UNCHANGED, which is the opposite of what the test's
//     own name says it checks, so it passed by asserting the wrong thing.
// Worse, the shape was wrong for the property: it edited the file and then reinstalled, and the
// reinstall overwrites the edit before anything reads it -- so the edit was never observable.
//
// What the stamp actually guarantees is narrower and worth stating: it is a function of the
// INSTALLED CONTENTS, so the same sources always produce the same stamp. That is what makes an
// unchanged install DETECTABLY unchanged. A changed source is a property of the WRITER, tested by
// hashing what is on disk before the next install runs.
describe("installed-copy manifest", () => {
  it("gives the same stamp for the same sources, so an unchanged install is detectably unchanged", () => {
    const binA = tempBin();
    const binB = tempBin();
    installHelpers(binA);
    installHelpers(binB);
    // Two independent installs of the same sources: the stamp is a function of content, not of
    // when or where it was written (installedAt differs; the stamp must not).
    expect(readInstallManifest(binB)!.stamp).toBe(readInstallManifest(binA)!.stamp);
  });

  it("records the hash of what it WRITES, so an edited file stops matching the record", () => {
    const bin = tempBin();
    installHelpers(bin);
    // The generation's copy is what runs, and `helpers` records it.
    expect(hash(readFileSync(genFile(bin, "opencadre-awareness.mjs"), "utf8"))).toBe(readInstallManifest(bin)!.helpers["opencadre-awareness.mjs"]);
    const recorded = readInstallManifest(bin)!.slots["opencadre-awareness.mjs"];
    // Read the file off disk BEFORE touching it: the assertion has to be about the bytes that were
    // installed, not about the manifest compared with itself.
    const installedText = readFileSync(path.join(bin, "opencadre-awareness.mjs"), "utf8");
    expect(hash(installedText)).toBe(recorded);

    // Now edit it, as a user would. The recorded hash must NOT follow the edit -- that difference is
    // exactly what driftReport and `--upgrade` rely on to spot a local modification.
    writeFileSync(path.join(bin, "opencadre-awareness.mjs"), "// the user changed this\n");
    const onDisk = readFileSync(path.join(bin, "opencadre-awareness.mjs"), "utf8");
    expect(hash(onDisk)).not.toBe(recorded);
    expect(readInstallManifest(bin)!.slots["opencadre-awareness.mjs"]).toBe(recorded);
  });

  it("returns the install to a known stamp after an upgrade, so 'stamp matches' means 'current'", () => {
    const fresh = (() => {
      const other = tempBin();
      installHelpers(other);
      return readInstallManifest(other)!.stamp;
    })();
    // An install from an OLDER CLI: its generation holds an older wake. This is the state an operator is in before
    // upgrading, and it is driftReport's job to name it.
    const bin = tempBin();
    olderInstall(bin, "opencadre-wake.mjs", "// an older revision\n");
    expect(readInstallManifest(bin)!.stamp).not.toBe(fresh);
    expect(driftReport(bin).stale).toContain("opencadre-wake.mjs");

    // After restoring from the current sources the install carries the SAME stamp a fresh install
    // does. That is the property worth pinning: the stamp describes the content, so two installs of
    // identical content report identical provenance however they got there.
    upgradeHelpers(bin);
    expect(readInstallManifest(bin)!.stamp).toBe(fresh);
    expect(driftReport(bin).stale).toEqual([]);
  });
  it("records a stamp and a per-file hash for every helper it writes", () => {
    const bin = tempBin();
    const written = installHelpers(bin);
    // Entry keys are paths relative to bin (the OpenCode plugin is a folder: "opencode-plugin/index.js"), so compare
    // relative paths, not basenames, or a nested entry can never match its key. The last one is the generation.
    expect(written.map((f) => path.relative(bin, f).split(path.sep).join("/")).sort()).toEqual([...Object.keys(ENTRIES), `.gen/${readPointer(bin).id}`].sort());

    const manifest = readInstallManifest(bin);
    expect(manifest).not.toBeNull();
    // Every helper the install wrote has an entry: a manifest that covered only some files would
    // let the uncovered ones drift silently, which is the exact failure this exists to expose.
    expect(Object.keys(hashesOf(manifest!)).sort()).toEqual(Object.keys(HELPERS).sort());
    for (const [name, hash] of Object.entries(hashesOf(manifest!))) {
      expect(hash, `${name} hash`).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(manifest!.stamp).toMatch(/^[0-9a-f]{12}$/);
    expect(Date.parse(manifest!.installedAt)).not.toBeNaN();
  });

  it("is byte-identical on a second install of unchanged sources", () => {
    const bin = tempBin();
    installHelpers(bin);
    const first = readInstallManifest(bin)!;
    installHelpers(bin);
    const second = readInstallManifest(bin)!;
    // The whole point: an unchanged install is DETECTABLY unchanged. installedAt deliberately
    // differs (it is a wall clock); the stamp and every hash must not.
    expect(second.stamp).toBe(first.stamp);
    expect(hashesOf(second)).toEqual(hashesOf(first));
  });

  it("returns null rather than throwing when there is no manifest (every machine today)", () => {
    // Backwards compatibility is a requirement, not a nicety: every existing install has no
    // manifest, and connect must keep working on those rather than failing on the missing file.
    const bin = tempBin();
    expect(readInstallManifest(bin)).toBeNull();
  });

  it("returns null on a corrupt manifest instead of throwing", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(installManifestPath(bin), "{not json");
    // A half-written manifest must degrade to "unknown", never to a crash in a user's connect.
    expect(readInstallManifest(bin)).toBeNull();
  });

  it("keeps the manifest out of the helper set, so nothing tries to run it", () => {
    const bin = tempBin();
    installHelpers(bin);
    // The manifest is dot-prefixed metadata, not a helper: HELPERS is the list of things that get
    // invoked and rewritten, and a metadata file must not appear as one of them.
    expect(Object.keys(HELPERS)).not.toContain(path.basename(installManifestPath(bin)));
    const entries = readdirSync(bin);
    expect(entries).toContain(path.basename(installManifestPath(bin)));
    // Recursive, so the nested plugin folder's files count too: at the root, exactly the entry stubs; in the generation,
    // exactly the helpers.
    const scripts = (readdirSync(bin, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).filter((f) => /\.m?js$/.test(f) && !f.startsWith(".gen/"));
    expect(scripts.sort()).toEqual(Object.keys(ENTRIES).sort());
    const inGen = (readdirSync(generationPath(bin, readPointer(bin).id!), { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).filter((f) => /\.m?js$/.test(f));
    expect(inGen.sort()).toEqual(Object.keys(HELPERS).sort());
  });

  it("does not leak a key into the manifest", () => {
    const bin = tempBin();
    installHelpers(bin);
    // installHelpers takes no credential, but this asserts the property rather than the argument:
    // the manifest is a file on disk in a directory users may share in a bug report.
    expect(readFileSync(installManifestPath(bin), "utf8")).not.toMatch(/agt_|dev_|org_|ocd_|Bearer/i);
  });

  it("survives a rebuild of the directory between installs", () => {
    const bin = tempBin();
    installHelpers(bin);
    const stamp = readInstallManifest(bin)!.stamp;
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    installHelpers(bin);
    expect(readInstallManifest(bin)!.stamp).toBe(stamp);
  });
});
// Drift reporting: the half that makes drift VISIBLE. installHelpers still repairs (a connect must
// leave a working install), but it now says what it found first -- otherwise the fact that a machine
// had been running a stale security control is erased by the very act of fixing it.
describe("installed-copy drift", () => {
  it("reports nothing when the install matches the sources", () => {
    const bin = tempBin();
    installHelpers(bin);
    const drift = driftReport(bin);
    expect(drift).toEqual({ stale: [], edited: [], missing: [], unstamped: false });
    expect(driftLine(drift)).toBeNull();
  });

  it("names a stale helper: the install is intact, but the CLI's copy has moved on", () => {
    const bin = tempBin();
    // An install from an older CLI: its generation's gate is behind the source.
    olderInstall(bin, "opencadre-approval-gate.mjs", "// the revision this machine installed\n");
    const drift = driftReport(bin);
    expect(drift.stale).toEqual(["opencadre-approval-gate.mjs"]);
    expect(drift.edited).toEqual([]);
    expect(driftLine(drift)).toContain("stale revision");
  });

  it("distinguishes an edited helper from a stale one", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-wake.mjs"), "// the user changed this\n");
    const drift = driftReport(bin);
    // Disagrees with the record -> edited, NOT stale. The two need different words because they need
    // different handling: a stale file is ours to replace, an edited one is the user's.
    expect(drift.edited).toEqual(["opencadre-wake.mjs"]);
    expect(drift.stale).toEqual([]);
    expect(driftLine(drift)).toContain("changed on this machine");
  });

  it("reports a missing helper rather than calling it stale", () => {
    const bin = tempBin();
    installHelpers(bin);
    rmSync(path.join(bin, "opencadre-usage.mjs"), { force: true });
    const drift = driftReport(bin);
    expect(drift.missing).toEqual(["opencadre-usage.mjs"]);
    expect(drift.stale).toEqual([]);
  });

  it("reports an unstamped install as UNKNOWN, not as wrong", () => {
    const bin = tempBin();
    installHelpers(bin);
    rmSync(installManifestPath(bin), { force: true });
    const drift = driftReport(bin);
    // Every machine installed before the stamp existed. Its freshness is unknown, which is a
    // different claim from "stale", and the line must not pretend otherwise.
    expect(drift.unstamped).toBe(true);
    expect(drift.stale).toEqual([]);
    expect(drift.edited).toEqual([]);
    expect(driftLine(drift)).toContain("no record of which revision");
  });

  it("installHelpers returns the drift it found, before repairing it", () => {
    const bin = tempBin();
    olderInstall(bin, "opencadre-wake.mjs", "// stale\n");
    const written = installHelpers(bin) as string[] & { drift: ReturnType<typeof driftReport> };
    // The report describes what was there BEFORE the write -- that is the whole point.
    expect(written.drift.stale).toContain("opencadre-wake.mjs");
    expect(driftReport(bin).stale).toEqual([]);
  });
});
