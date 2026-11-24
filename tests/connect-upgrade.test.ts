import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { ENTRIES, HELPERS, installedText, installManifestPath, readInstallManifest } from "../cli/lib/helpers.mjs";
import { stubText } from "../cli/lib/stubs.mjs";
import { cliBuild, generationPath, installHelpers, makeTarget, planUpgrade, readPointer, upgradeHelpers } from "../cli/lib/generations.mjs";
import { packedInputs, walkFiles } from "../scripts/cli-build-info.mjs";
import { packCli } from "../scripts/pack-cli.mjs";

// Each test installs whole generations (tens of files, fsynced); on a shared, loaded box that outlasts the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");

// The child reads ONLY its test home (tests/helpers/isolated-cli-env.ts, board task 777eb656). The old builder copied
// the parent AFTER setting HOME/USERPROFILE and kept APPDATA/LOCALAPPDATA, so a real %APPDATA% client config could reach
// the CLI under test (review of #692; Olive measured four exit-3 mismatches from exactly that in connect-reconcile).
const runCli = (args: string[], home: string, cli = CLI, parent: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: isolatedCliEnv(home, parent) });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });

// `connect --upgrade`: the acting half of the installed-copy provenance. Since Q1g PR-2 it installs a whole new
// GENERATION (cli/lib/generations.mjs) behind stable entry stubs, verified against the hub's manifest first.
//
// The safety property this file exists for: an upgrade replaces files that RUN -- hooks and the approval gate are
// invoked from ~/.opencadre/bin by absolute path, and a user may legitimately have edited one. So a local modification
// must be REPORTED, not silently clobbered, and only --force may replace it (after a durable backup).

const tempBin = () => path.join(tmpDir("oc-upgrade-"), "bin");
const tempHome = () => tmpDir("oc-upgrade-home-");
const read = (bin: string, name: string) => readFileSync(path.join(bin, ...name.split("/")), "utf8");
const stub = (name: string) => stubText(name, installedText(name));
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const olderTarget = (name: string, text: string) => makeTarget({ files: { ...Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)])), [name]: text } });

/** Every file under `dir` -> sha256, for "nothing was written". */
function snapshot(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(walkFiles(dir).map((f: { path: string; bytes: Buffer }) => [f.path, sha(f.bytes.toString("latin1"))]));
}

describe("connect --upgrade (library)", () => {
  it("refreshes a stale helper: the new generation holds the CLI's copy, the stub stays", () => {
    const bin = tempBin();
    installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// an older revision\n") });
    const result = upgradeHelpers(bin);
    expect(result.changed).toEqual(["opencadre-wake.mjs"]);
    expect(read(generationPath(bin, result.id), "opencadre-wake.mjs")).toBe(installedText("opencadre-wake.mjs"));
    expect(read(bin, "opencadre-wake.mjs")).toBe(stub("opencadre-wake.mjs"));
    expect(result.refused).toEqual([]);
    expect(readInstallManifest(bin)!.helpers["opencadre-wake.mjs"]).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is a no-op on an install that is already current", () => {
    const bin = tempBin();
    installHelpers(bin);
    const before = readInstallManifest(bin)!.stamp;
    const result = upgradeHelpers(bin);
    expect(result.changed).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(readInstallManifest(bin)!.stamp).toBe(before);
  });

  it("REFUSES to replace an entry that was edited locally, and says which; everything else still upgrades", () => {
    const bin = tempBin();
    installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// older\n") });
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), "// locally tuned gate\n");
    const result = upgradeHelpers(bin);
    expect(result.refused).toEqual(["opencadre-approval-gate.mjs"]);
    expect(read(bin, "opencadre-approval-gate.mjs")).toBe("// locally tuned gate\n");
    expect(result.changed).toContain("opencadre-wake.mjs");
    expect(readPointer(bin).id).toBe(cliBuild().id);
  });

  it("replaces a locally edited entry only with force, after a durable backup", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), "// locally tuned gate\n");
    const result = upgradeHelpers(bin, { force: true });
    expect(result.refused).toEqual([]);
    expect(result.backups.map((f: string) => readFileSync(f, "utf8"))).toEqual(["// locally tuned gate\n"]);
    expect(read(bin, "opencadre-approval-gate.mjs")).toBe(stub("opencadre-approval-gate.mjs"));
  });

  it("restores a missing entry rather than reporting it as a local edit", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-awareness.mjs"), "");
    const result = upgradeHelpers(bin);
    expect(result.refused).toEqual([]);
    expect(read(bin, "opencadre-awareness.mjs")).toBe(stub("opencadre-awareness.mjs"));
  });

  it("works on an install with no manifest at all: current stubs are current, the manifest is written", () => {
    const bin = tempBin();
    installHelpers(bin);
    // Every machine installed before the stamp existed has no manifest. Stubs equal to this CLI's are current by
    // content, whatever the record says.
    writeFileSync(installManifestPath(bin), "");
    const result = upgradeHelpers(bin);
    expect(result.refused).toEqual([]);
    expect(readInstallManifest(bin)).not.toBeNull();
  });

  it("removes a stale .bak- file left by an older install (unchanged retention)", () => {
    const bin = tempBin();
    installHelpers(bin);
    const bak = path.join(bin, "opencadre-config.mjs.bak-20260915152059");
    writeFileSync(bak, "// old backup\n");
    const result = upgradeHelpers(bin);
    expect(result.removed).toContain("opencadre-config.mjs.bak-20260915152059");
    expect(readdirSync(bin)).not.toContain("opencadre-config.mjs.bak-20260915152059");
  });

  it("never treats a non-helper file as its own, so unrelated files are untouched", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "my-notes.txt"), "mine\n");
    const result = upgradeHelpers(bin);
    expect(read(bin, "my-notes.txt")).toBe("mine\n");
    expect(result.changed).not.toContain("my-notes.txt");
    expect(result.removed).not.toContain("my-notes.txt");
  });

  it("keeps the manifest's helper set exactly the managed helpers, and its slots exactly the entries", () => {
    const bin = tempBin();
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-usage.mjs"), "// stale\n");
    upgradeHelpers(bin, { force: true });
    expect(Object.keys(readInstallManifest(bin)!.helpers).sort()).toEqual(Object.keys(HELPERS).sort());
    expect(Object.keys(readInstallManifest(bin)!.slots).sort()).toEqual(Object.keys(ENTRIES).sort());
  });

  it("plans exactly what the real run then does", () => {
    const bin = tempBin();
    installHelpers(bin, { target: olderTarget("opencadre-usage.mjs", "// older\n") });
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), "// locally tuned\n");
    const plan = planUpgrade(bin, { force: false });
    expect(plan.refused).toContain("opencadre-approval-gate.mjs");
    const real = upgradeHelpers(bin, { force: false });
    expect(real.refused).toEqual(plan.refused);
    expect(real.changed).toEqual(plan.changed);
    expect(real.removed).toEqual(plan.removed);
  });
});

// The library above is only useful if the command reaches it. These run the real CLI, with no PATH. Run from this
// checkout the CLI has no build.json, so it can never match a hub's build: these use --offline, and the hub-verified
// path is exercised below with a STAGED packed CLI.
describe("opencadre connect --upgrade --offline (end to end, from a checkout)", () => {
  it("reports an already-current install, says it is unverified, and exits 0", async () => {
    const home = tempHome();
    installHelpers(path.join(home, ".opencadre", "bin"));
    const r = await runCli(["connect", "--upgrade", "--offline", "--home", home], home);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Already current");
    expect(r.out).toContain("Not verified against a hub (--offline)");
    // The revision detail is the full report's: saved on every run, and its path printed.
    const report = path.join(home, ".opencadre", "last-upgrade.txt");
    expect(r.out).toContain(`Full report: ${report}`);
    expect(readFileSync(report, "utf8")).toContain("Installed revision:");
  }, 60_000);

  it("refreshes a stale install and names the files it changed", async () => {
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// older\n") });
    const r = await runCli(["connect", "--upgrade", "--offline", "--home", home], home);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Updated to revision [0-9a-f]{12} \(generation /);
    // Which files changed is the full report's (--verbose, and the saved file).
    const full = readFileSync(path.join(home, ".opencadre", "last-upgrade.txt"), "utf8");
    expect(full).toContain("Upgraded");
    expect(full).toContain("opencadre-wake.mjs");
    expect(read(generationPath(bin, readPointer(bin).id!), "opencadre-wake.mjs")).toBe(installedText("opencadre-wake.mjs"));
  }, 60_000);

  it("a helper edited on this machine is left alone, listed as owed, and exits 3 (never 0 under a to-do list)", async () => {
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// older\n") });
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), "// edited on this machine\n");
    const r = await runCli(["connect", "--upgrade", "--offline", "--home", home], home);
    expect(r.code, r.err).toBe(3);
    expect(r.out).toContain("What you need to do:\n  1. OpenCadre helpers: One helper file was left alone");
    expect(r.out).toContain("opencadre-approval-gate.mjs");
    expect(r.out).toContain("--force");
    expect(r.out).not.toContain("Nothing for you to do");
    expect(read(bin, "opencadre-approval-gate.mjs")).toBe("// edited on this machine\n");
  }, 60_000);

  it("--dry-run writes nothing, including to a stale install", async () => {
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    installHelpers(bin, { target: olderTarget("opencadre-usage.mjs", "// stale, untouched\n") });
    const before = snapshot(bin);
    const r = await runCli(["connect", "--upgrade", "--dry-run", "--offline", "--home", home], home);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Dry run: nothing was written");
    expect(r.out).toContain("opencadre-usage.mjs");
    expect(snapshot(bin)).toEqual(before);
  }, 60_000);

  it("lists the same removed backups the real run then removes", async () => {
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    installHelpers(bin);
    writeFileSync(path.join(bin, "opencadre-wake.mjs.bak-20260101000000"), "// old backup\n");
    const dry = await runCli(["connect", "--upgrade", "--dry-run", "--offline", "--home", home], home);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("opencadre-wake.mjs.bak-20260101000000");
    expect(readdirSync(bin)).toContain("opencadre-wake.mjs.bak-20260101000000");
    const real = await runCli(["connect", "--upgrade", "--offline", "--verbose", "--home", home], home);
    expect(real.code).toBe(0);
    expect(real.out).toContain("opencadre-wake.mjs.bak-20260101000000");
    expect(readdirSync(bin)).not.toContain("opencadre-wake.mjs.bak-20260101000000");
  }, 60_000);

  it("refuses --force or --offline without --upgrade, rather than silently ignoring them", async () => {
    const home = tempHome();
    const force = await runCli(["connect", "--force", "--home", home], home);
    expect(force.code).toBe(2);
    expect(force.err).toContain("--force applies to --upgrade only");
    const offline = await runCli(["connect", "--offline", "--home", home], home);
    expect(offline.code).toBe(2);
    expect(offline.err).toContain("--offline applies to --upgrade only");
    // --verbose has a meaning only where there is a short form: connect and connect --upgrade.
    const verbose = await runCli(["update", "--status", "--verbose", "--home", home], home);
    expect(verbose.code).toBe(2);
    expect(verbose.err).toContain("--verbose applies to connect and connect --upgrade only");
  }, 60_000);

  it("refuses to convert a legacy install while a consumer is live, names it, and --force converts anyway", async () => {
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of Object.keys(HELPERS)) {
      mkdirSync(path.dirname(path.join(bin, ...name.split("/"))), { recursive: true });
      writeFileSync(path.join(bin, ...name.split("/")), installedText(name));
    }
    // The manifest the in-place installer wrote (12-hex hashes of each root file), so these are known official files.
    writeFileSync(installManifestPath(bin), JSON.stringify({ cliVersion: "0.1.0", stamp: "000000000000", installedAt: "2026-09-01T00:00:00Z", helpers: Object.fromEntries(Object.keys(HELPERS).map((n) => [n, sha(installedText(n)).slice(0, 12)])) }));
    // A live wake watcher's lock (opencadre-wake.mjs takeLock): a process this test started and will stop. Like a
    // watcher, it is node running opencadre-wake.mjs from an install's bin: the inventory counts a lock's pid only then.
    const fakeWatcher = path.join(tmpDir("oc-fake-watcher-"), ".opencadre", "bin", "opencadre-wake.mjs");
    mkdirSync(path.dirname(fakeWatcher), { recursive: true });
    writeFileSync(fakeWatcher, "setTimeout(() => {}, 120000);\n");
    const sleeper = spawn(process.execPath, [fakeWatcher]);
    // And a lock whose pid now belongs to an unrelated process (a reused pid): shown, never counted.
    const reused = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
    try {
      writeFileSync(path.join(home, ".opencadre", "wake-0123456789abcdef.lock"), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() }));
      writeFileSync(path.join(home, ".opencadre", "wake-fedcba9876543210.lock"), JSON.stringify({ pid: reused.pid, startedAt: Date.now() }));
      const before = snapshot(bin);
      const dry = await runCli(["connect", "--upgrade", "--offline", "--dry-run", "--home", home], home);
      expect(dry.code, dry.err).toBe(0);
      expect(dry.out).toMatch(new RegExp(`wake watcher pid ${sleeper.pid}: started [^\\n]*command [^\\n]*opencadre-wake\\.mjs`));
      expect(dry.out).toContain(`stale lock ignored, pid ${reused.pid}: pid ${reused.pid} was reused by node`);
      const refused = await runCli(["connect", "--upgrade", "--offline", "--home", home], home);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(`wake watcher pid ${sleeper.pid}`);
      expect(refused.err).not.toContain(`wake watcher pid ${reused.pid}`);
      expect(refused.err).toContain(`stale lock ignored, pid ${reused.pid}`);
      expect(refused.err).toContain("nothing was changed");
      expect(snapshot(bin)).toEqual(before);
      const forced = await runCli(["connect", "--upgrade", "--offline", "--force", "--home", home], home);
      // Exit 3: the conversion is done, but the user owes a restart (the list and the exit code agree).
      expect(forced.code, forced.err).toBe(3);
      // Safety-relevant, so in the SHORT report too: these still run the old helpers and must be restarted.
      expect(forced.out).toContain("What you need to do:\n  1. OpenCadre helpers: Restart these, which were running while the install was converted (--force), so they load the new helpers: ");
      expect(forced.out).toContain(`wake watcher pid ${sleeper.pid}`);
      expect(readFileSync(path.join(home, ".opencadre", "last-upgrade.txt"), "utf8")).toContain("Converted while these were live");
      expect(read(bin, "opencadre-approval-gate.mjs")).toBe(stub("opencadre-approval-gate.mjs"));
      // The legacy root libraries are untouched by conversion.
      expect(read(bin, "opencadre-config.mjs")).toBe(installedText("opencadre-config.mjs"));
    } finally {
      sleeper.kill();
      reused.kill();
    }
  }, 120_000);
});

// Old-CLI refusal and hub verification (plan §C, ruling 049a §4), against a STAGED packed CLI (cli/ + helpers/ +
// build.json, what scripts/pack-cli.mjs stages before `npm pack`) and a local hub serving /cli/manifest.json. The build
// id is read from build.json as an opaque value: how inputsDigest is computed is PR-1's business.
describe("opencadre connect --upgrade, verified against the hub's manifest", () => {
  let staged: string;
  let build: Record<string, unknown> & { inputsDigest: string; helpers: Record<string, string> };
  let manifestBody: unknown = null;
  let server: Server;
  let hub: string;

  beforeAll(async () => {
    // The real package: PR-1's packCli (npm pack, build.json over exactly what npm packed), extracted as npx would.
    const out = tmpDir("oc-staged-cli-pack-");
    const packed = packCli({ out, log: () => {} });
    staged = tmpDir("oc-staged-cli-");
    for (const f of packedInputs(readFileSync(packed.target))) {
      mkdirSync(path.dirname(path.join(staged, ...f.path.split("/"))), { recursive: true });
      writeFileSync(path.join(staged, ...f.path.split("/")), f.bytes);
    }
    build = JSON.parse(readFileSync(path.join(staged, "build.json"), "utf8"));
    server = createServer((req, res) => {
      if (req.url === "/cli/manifest.json" && manifestBody !== null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(typeof manifestBody === "string" ? manifestBody : JSON.stringify(manifestBody));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const stagedCli = () => path.join(staged, "bin", "opencadre.mjs");
  const manifestFor = (b: typeof build) => {
    const tarSha = sha(`tarball of ${b.inputsDigest}`);
    const stamp = tarSha.slice(0, 12);
    return { ...b, tarball: { sha256: tarSha, bytes: 1, stamp, url: `${hub}/cli/${stamp}/opencadre-cli.tgz` }, command: `npx -y ${hub}/cli/${stamp}/opencadre-cli.tgz connect --upgrade` };
  };

  it("installs the hub's current build, verified, as generation <inputsDigest-12>", async () => {
    manifestBody = manifestFor(build);
    const home = tempHome();
    const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home, stagedCli());
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Verified against ${hub}`);
    const bin = path.join(home, ".opencadre", "bin");
    expect(readPointer(bin).id).toBe(build.inputsDigest.slice(0, 12));
    expect(readInstallManifest(bin)!.build.inputsDigest).toBe(build.inputsDigest);
  }, 120_000);

    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("a helper refused as unknown while the served build had NO history (production 480c850e) is refreshed once the hub's build has it", async () => {
    // Mutant: classify() keeping a previous "unknown" refusal without re-checking the history -> exit 3, slot kept.
    const GATE = "opencadre-approval-gate.mjs";
    const repoPath = HELPERS[GATE];
    const shas = spawnSync("git", ["log", "--format=%H", "--", repoPath], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(shas.length, `${repoPath} needs history`).toBeGreaterThan(1);
    const gateOld = spawnSync("git", ["show", `${shas[1]}:${repoPath}`], { encoding: "utf8" }).stdout.replaceAll("../../scripts/", "./");
    // Known positive: the packed build's officialHistory holds the old gate's installed text.
    expect((build as unknown as { officialHistory: Record<string, string[]> }).officialHistory[GATE]).toContain(sha(gateOld));
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, GATE), gateOld);
    // The window: the same helpers, served with provenance "none" (an empty history for every one).
    const files = Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)]));
    const window = upgradeHelpers(bin, { target: makeTarget({ files, history: Object.fromEntries(Object.keys(files).map((n) => [n, []])) }) });
    expect(window.refused).toEqual([GATE]);
    expect(readInstallManifest(bin)!.refused).toEqual({ [GATE]: "unknown" });
    manifestBody = manifestFor(build);
    const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home, stagedCli());
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).not.toContain("left alone");
    expect(read(bin, GATE)).toBe(stub(GATE));
    expect(readInstallManifest(bin)!.refused).toEqual({});
    expect(readdirSync(bin)).not.toContain(".backup");
  }, 120_000);

  it("an OLD CLI (its build is not the hub's) refuses before any write and prints the hub's stamped command", async () => {
    const newer = { ...build, inputsDigest: sha("a newer build") };
    manifestBody = manifestFor(newer);
    const home = tempHome();
    const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home, stagedCli());
    expect(r.code).toBe(2);
    expect(r.err).toContain("not the hub's current CLI");
    expect(r.err).toContain(`${hub}/cli/${(manifestBody as { tarball: { stamp: string } }).tarball.stamp}/opencadre-cli.tgz connect --upgrade`);
    expect(r.err).not.toMatch(/\/cli\/opencadre-cli\.tgz/);
    expect(existsSync(path.join(home, ".opencadre"))).toBe(false);
  }, 120_000);

  it("a CLI run from a checkout is never the hub's build: refused without --offline", async () => {
    manifestBody = manifestFor(build);
    const home = tempHome();
    const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home);
    expect(r.code).toBe(2);
    expect(r.err).toContain("a CLI run from a checkout");
    expect(existsSync(path.join(home, ".opencadre"))).toBe(false);
  }, 120_000);

  for (const [label, body] of [["offline (404)", null], ["not JSON", "<html>"], ["not a CLI manifest", { hello: 1 }]] as const) {
    it(`a manifest that is ${label} is a refusal: exit 2, no writes, no bare URL`, async () => {
      manifestBody = body;
      const home = tempHome();
      const bin = path.join(home, ".opencadre", "bin");
      installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// older\n") });
      const before = snapshot(bin);
      const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home, stagedCli());
      expect(r.code).toBe(2);
      expect(r.err).toContain("Could not verify this CLI");
      expect(r.err).not.toMatch(/\/cli\/opencadre-cli\.tgz/);
      expect(snapshot(bin)).toEqual(before);
    }, 120_000);
  }

  it("an unreachable hub is a refusal too", async () => {
    const home = tempHome();
    const r = await runCli(["connect", "--upgrade", "--hub", "http://127.0.0.1:9", "--home", home], home, stagedCli());
    expect(r.code).toBe(2);
    expect(r.err).toContain("unreachable");
    expect(existsSync(path.join(home, ".opencadre"))).toBe(false);
  }, 120_000);

  it("a manifest whose helper hashes disagree with this CLI's files fails verification: nothing is switched", async () => {
    const tampered = { ...build, helpers: { ...build.helpers, "opencadre-hook-dialect.mjs": sha("not the dialect this CLI carries") } };
    manifestBody = manifestFor(tampered);
    const home = tempHome();
    const bin = path.join(home, ".opencadre", "bin");
    installHelpers(bin, { target: olderTarget("opencadre-wake.mjs", "// older\n") });
    const pointer = readPointer(bin).id;
    const manifestBefore = readFileSync(installManifestPath(bin), "utf8");
    const r = await runCli(["connect", "--upgrade", "--hub", hub, "--home", home], home, stagedCli());
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not verify");
    expect(readPointer(bin).id).toBe(pointer);
    expect(readFileSync(installManifestPath(bin), "utf8")).toBe(manifestBefore);
  }, 120_000);
});

describe("test isolation: a decoy parent environment never reaches this file's CLI child (board task 777eb656)", () => {
  /** A home that looks like an older OpenCadre install, at the places HOME / APPDATA / XDG_CONFIG_HOME / CODEX_HOME resolve to. */
  function decoyParent() {
    const decoy = tmpDir("oc-upgrade-decoy-");
    const bin = path.join(decoy, ".opencadre", "bin");
    mkdirSync(bin, { recursive: true });
    installHelpers(bin);
    // Devin uses APPDATA on Windows and XDG_CONFIG_HOME on other platforms.
    const devinDir = process.platform === "win32" ? path.join(decoy, "AppData", "Roaming", "devin") : path.join(decoy, ".config", "devin");
    mkdirSync(devinDir, { recursive: true });
    writeFileSync(path.join(devinDir, "mcp_config.json"),
      `${JSON.stringify({ mcpServers: { "opencadre-session": { command: "node", args: [path.join(bin, "opencadre-mcp.mjs"), "--client", "devin"] } } }, null, 2)}
`);
    const parent: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: decoy, USERPROFILE: decoy, Home: decoy,
      APPDATA: path.join(decoy, "AppData", "Roaming"), AppData: path.join(decoy, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(decoy, "AppData", "Local"), XDG_CONFIG_HOME: path.join(decoy, ".config"),
      CODEX_HOME: path.join(decoy, ".codex"), codex_home: path.join(decoy, ".codex"),
      OPENCADRE_HOOK_HOME: decoy,
    };
    return { decoy, parent };
  }
  const snapshot = (dir: string): Record<string, string> => Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
      const p = path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name);
      return [p, readFileSync(p, "utf8")];
    }));

  it("known positive: pointed AT the decoy, the CLI sees its install (so the control below can fail)", async () => {
    const { decoy, parent } = decoyParent();
    const r = await runCli(["connect", "--upgrade", "--offline", "--dry-run", "--home", decoy], decoy, CLI, parent);
    expect(r.code, r.out + r.err).toBe(0);
    // The configured Devin entry is DISCOVERED (a report-only client), not merely the --home destination echoed back:
    // this proves the child read the decoy's platform-native client config, so the control below can fail.
    expect(r.out).toContain("  Devin");
  });

  it("control: with the decoy as the parent's HOME/APPDATA/AppData/XDG_CONFIG_HOME/CODEX_HOME/OPENCADRE_HOOK_HOME, the child reads only its own test home and leaves the decoy byte-identical", async () => {
    const { decoy, parent } = decoyParent();
    const before = snapshot(decoy);
    const home = tempHome();
    const r = await runCli(["connect", "--upgrade", "--offline", "--dry-run", "--home", home], home, CLI, parent);
    // A successful run, so an unrelated child failure cannot satisfy the absence checks below.
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).not.toContain("  Devin");
    expect(r.out + r.err).not.toContain(decoy);
    expect(snapshot(decoy)).toEqual(before);
  });
});
