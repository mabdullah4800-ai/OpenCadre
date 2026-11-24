// Q1g follow-up: the production build gets its CLI helpers' git history from the deploy archive (cli-provenance.json),
// because the image is built from `git archive` output with no .git. PR-2's "known official old" rule reads that history.
//
//   (a) no git + a provenance file: build.json carries its commit and history, provenance "deploy-archive", dirty [].
//   (b) a malformed provenance file FAILS the pack; it never degrades to empty histories.
//   (c) `provenance <ref>`: a helper's history includes its installed-text hash AT <ref> and excludes a revision committed
//       after <ref> (a throwaway git repo, so the history is exactly known).
//   (d) neither git nor a file: provenance "none", commit null, empty histories.
//   and scripts/deploy-archive.sh: the archive carries cli-provenance.json at its root, equal to `provenance <ref>`, on
//   both the `--add-file` branch and the tar-append fallback.
//
// (a), (b) and (d) pack exactly as the image's build stage does: the Dockerfile's build-stage sources copied to a folder
// with no .git above it (GIT_CEILING_DIRECTORIES stops git's upward search), then `node scripts/pack-cli.mjs`.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { installedHash, provenanceFor, revisionHashes } from "../scripts/cli-build-info.mjs";

const { tarEntry } = await import("../src/cli-package.js");
const ROOT = process.cwd();
const HEAD = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
// Video release refs require external approved assets. These two existing branches explicitly exercise a legacy
// ref without a video manifest, so the provenance compatibility test remains independent of local bulk media.
const mediaIntroduced = spawnSync("git", ["log", "--diff-filter=A", "--format=%H", "--", "media/site-videos.json"], {encoding:"utf8"}).stdout.trim().split(/\r?\n/)[0];
const ARCHIVE_REF = mediaIntroduced ? `${mediaIntroduced}^` : "HEAD";
const HAS_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** The image build stage's inputs (Dockerfile: package*.json, cli, scripts, examples/hooks, examples/opencode-plugin),
 * copied under a folder git cannot see above. Returns the copy's root and the env that keeps git out. */
function buildStage(provenance?: string) {
  const outer = tmpDir("oc-deploy-stage-");
  const root = path.join(outer, "app");
  for (const p of ["cli", "scripts", "examples/hooks", "examples/opencode-plugin", "package.json"]) cpSync(path.join(ROOT, p), path.join(root, p), { recursive: true });
  if (provenance !== undefined) writeFileSync(path.join(root, "cli-provenance.json"), provenance);
  return { root, env: { ...process.env, GIT_CEILING_DIRECTORIES: outer } };
}

function pack(stage: { root: string; env: NodeJS.ProcessEnv }) {
  const out = tmpDir("oc-deploy-pack-");
  const r = spawnSync(process.execPath, [path.join(stage.root, "scripts", "pack-cli.mjs"), "--out", out], { cwd: stage.root, env: stage.env, encoding: "utf8" });
  const build = r.status === 0 ? JSON.parse(tarEntry(readFileSync(path.join(out, "opencadre-cli.tgz")), "package/build.json")!.toString("utf8")) : null;
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, build };
}

describe("pack without .git", () => {
  it("(a) takes commit and history from cli-provenance.json: provenance deploy-archive, dirty []", async () => {
    const provenance = await provenanceFor({ ref: "HEAD" });
    const r = pack(buildStage(JSON.stringify(provenance)));
    expect(r.status, r.stderr).toBe(0);
    expect(r.build.provenance).toBe("deploy-archive");
    expect(r.build.commit).toBe(HEAD);
    expect(r.build.dirty).toEqual([]);
    for (const [name, hashes] of Object.entries(provenance.officialHistory as Record<string, string[]>)) {
      expect(r.build.officialHistory[name], name).toEqual(expect.arrayContaining(hashes));
      // ...and the packed text itself, as with git.
      expect(r.build.officialHistory[name], name).toContain(r.build.helpers[name]);
    }
    // Real depth, not just the packed revision: the gate has a long history.
    expect(r.build.officialHistory["opencadre-approval-gate.mjs"].length).toBe(new Set([...provenance.officialHistory["opencadre-approval-gate.mjs"], r.build.helpers["opencadre-approval-gate.mjs"]]).size);
  }, 300_000);

  it("(b) a malformed provenance file fails the pack loudly, naming the file", async () => {
    const good = await provenanceFor({ ref: "HEAD" });
    const bad: Array<[string, RegExp]> = [
      ["{ not json", /cli-provenance\.json is not valid JSON/],
      [JSON.stringify({ ...good, schema: 2 }), /malformed: schema is 2/],
      [JSON.stringify({ ...good, commit: "abc" }), /malformed: commit is not a full commit sha/],
      [JSON.stringify({ ...good, officialHistory: { ...good.officialHistory, "pure-ack.mjs": ["nothex"] } }), /officialHistory\["pure-ack\.mjs"\] is not a list of sha256 hex/],
      [JSON.stringify({ ...good, officialHistory: { "pure-ack.mjs": good.officialHistory["pure-ack.mjs"] } }), /no history for packed helper/],
    ];
    for (const [text, why] of bad) {
      const r = pack(buildStage(text));
      expect(r.status, text.slice(0, 40)).not.toBe(0);
      expect(r.stderr, text.slice(0, 40)).toMatch(why);
    }
  }, 600_000);

  it("(d) with neither git nor a file: provenance none, commit null, empty histories", () => {
    const r = pack(buildStage());
    expect(r.status, r.stderr).toBe(0);
    expect(r.build.provenance).toBe("none");
    expect(r.build.commit).toBeNull();
    expect(r.build.dirty).toEqual([]);
    for (const hashes of Object.values(r.build.officialHistory)) expect(hashes).toEqual([]);
  }, 300_000);

  it("control: the same pack in the checkout says provenance git, with HEAD", () => {
    const out = tmpDir("oc-deploy-pack-git-");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs"), "--out", out], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const build = JSON.parse(tarEntry(readFileSync(path.join(out, "opencadre-cli.tgz")), "package/build.json")!.toString("utf8"));
    expect(build.provenance).toBe("git");
    expect(build.commit).toBe(HEAD);
  }, 300_000);
});

describe("(c) provenance <ref> against a throwaway repo", () => {
  it("includes the helper's hash at <ref> and every earlier revision, and excludes a revision committed after <ref>", () => {
    const repo = tmpDir("oc-provenance-repo-");
    const g = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g("init", "-q");
    mkdirSync(path.join(repo, "cli", "lib"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(path.join(repo, "cli", "lib", "helpers.mjs"), 'export const HELPERS = { "a.mjs": "scripts/a.mjs" };\nexport const installTransform = (t) => t.replaceAll("../../scripts/", "./");\n');
    const revs = ['import "../../scripts/b.mjs";\nexport const v = 1;\n', "export const v = 2;\n", "export const v = 3;\n"];
    const commits: string[] = [];
    for (const text of revs) {
      writeFileSync(path.join(repo, "scripts", "a.mjs"), text);
      g("add", "-A");
      g("commit", "-q", "-m", `v${commits.length + 1}`);
      commits.push(g("rev-parse", "HEAD"));
    }
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "cli-build-info.mjs"), "provenance", commits[1]], { cwd: repo, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe(1);
    expect(out.commit).toBe(commits[1]);
    const history: string[] = out.officialHistory["a.mjs"];
    const buf = (s: string) => Buffer.from(s, "utf8");
    // At <ref>, and before it (the first through the install rewrite: "../../scripts/" -> "./").
    expect(history).toContain(installedHash(buf(revs[1])));
    expect(history).toContain(installedHash(buf(revs[0])));
    expect(installedHash(buf(revs[0]))).toBe(installedHash(buf('import "./b.mjs";\nexport const v = 1;\n')));
    // After it: absent. And exactly the two revisions, each in both line-ending renderings.
    expect(history).not.toContain(installedHash(buf(revs[2])));
    expect(history).not.toContain(installedHash(buf(revs[2].replace(/\n/g, "\r\n"))));
    expect([...history].sort()).toEqual([...new Set([...revisionHashes(buf(revs[0])), ...revisionHashes(buf(revs[1]))])].sort());
    expect(history).toContain(installedHash(buf(revs[1].replace(/\n/g, "\r\n"))));

    const bad = spawnSync(process.execPath, [path.join(ROOT, "scripts", "cli-build-info.mjs"), "provenance", "no-such-ref"], { cwd: repo, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/no-such-ref does not name a commit/);
  }, 60_000);
});

describe.skipIf(!HAS_SH)("scripts/deploy-archive.sh", () => {
  // Whether THIS git offers --add-file, asked independently of the script (git >= 2.35 does). The arm that expects the
  // add-file branch only runs where it exists, and asserts the script really took it (a mis-detection falls back silently
  // and still yields a correct archive, which is exactly how the first version's `--add-file` grep went unnoticed).
  const help = spawnSync("git", ["archive", "-h"], { encoding: "utf8" });
  const gitHasAddFile = /add-file </.test(`${help.stdout}${help.stderr}`);
  const arms = [
    { branch: "add-file", env: {}, runs: gitHasAddFile },
    { branch: "tar-append", env: { OPENCADRE_ARCHIVE_NO_ADD_FILE: "1" }, runs: true },
  ];
  for (const { branch, env, runs } of arms) {
    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
    it.skip(`${branch}: the archive of <ref> carries cli-provenance.json at its root, equal to \`provenance <ref>\``, async () => {
      const out = path.join(tmpDir("oc-deploy-archive-"), "src.tar.gz");
      const r = spawnSync("sh", [path.join(ROOT, "scripts", "deploy-archive.sh"), ARCHIVE_REF, out], { cwd: ROOT, env: { ...process.env, ...env, OPENCADRE_ARCHIVE_TRACE: "1" }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(`deploy-archive: branch ${branch}`);
      const archive = readFileSync(out);
      const shipped = tarEntry(archive, "cli-provenance.json");
      expect(shipped, "cli-provenance.json at the archive root").not.toBeNull();
      expect(JSON.parse(shipped!.toString("utf8"))).toEqual(await provenanceFor({ ref: ARCHIVE_REF }));
      // Still the archive of the ref: a committed file is there.
      expect(tarEntry(archive, "Dockerfile")).not.toBeNull();
    }, 60_000);
  }
});
