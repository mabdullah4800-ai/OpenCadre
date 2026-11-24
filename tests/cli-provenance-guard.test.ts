// OPENCADRE_REQUIRE_CLI_PROVENANCE (src/cli-provenance-guard.ts): with the flag at 1, /health is 503 with a named reason
// unless the CLI package the hub serves says provenance "deploy-archive" or "git", a full 40-hex commit (that the deployed
// OPENCADRE_VERSION is a prefix of, when that version is a sha), and a non-empty officialHistory for every helper. The
// deploy scripts keep a new image only if /health answers ok, so a hub built without provenance rolls itself back.
//
// The 2026-10-06 regression is the "none" arm: production 480c850e served provenance "none", commit null and 22 empty
// histories because the deploy ran a stale deploy-vps.sh with no deploy-archive.sh step. Flag unset, that shape stays
// healthy: self-hosters build from plain checkouts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { tmpDir } from "./helpers/tmp.js";

const { app } = await import("../src/rest.js");
const { cliProvenanceProblem, REQUIRE_CLI_PROVENANCE_ENV } = await import("../src/cli-provenance-guard.js");

const FULL = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);

/** A ustar archive of `entries`, gzipped: the shape npm pack writes, enough for tarEntry. */
function tgz(entries: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body } of entries) {
    const data = Buffer.from(body, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(`${"0".repeat(11)}\0`, 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A build.json as pack-cli writes it, from a deploy archive, for two helpers. */
const goodBuild = () => ({
  schema: 1,
  provenance: "deploy-archive",
  commit: FULL,
  dirty: [],
  inputsDigest: HASH,
  helpers: { "a.mjs": HASH, "b.mjs": HASH },
  imports: { "a.mjs": [], "b.mjs": [] },
  officialHistory: { "a.mjs": [HASH], "b.mjs": [HASH, "b".repeat(64)] },
});
/** The production shape of 2026-10-06: a plain-archive build. */
const noneBuild = () => ({ ...goodBuild(), provenance: "none", commit: null, officialHistory: { "a.mjs": [], "b.mjs": [] } });

const dir = tmpDir("oc-cli-provenance-guard-");
let n = 0;
/** Serves `bytes` as the CLI package at a fresh path (a fresh path is a fresh snapshot: no cache carries over). */
function serve(bytes: Buffer | null) {
  const file = path.join(dir, `pkg-${n++}.tgz`);
  if (bytes) writeFileSync(file, bytes);
  vi.stubEnv("OPENCADRE_CLI_TARBALL", file);
}
const serveBuild = (build: unknown) => serve(tgz([{ name: "package/package.json", body: "{}" }, { name: "package/build.json", body: JSON.stringify(build) }]));

let baseUrl: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.unstubAllEnvs());

async function health() {
  const res = await fetch(`${baseUrl}/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("flag on: /health refuses a CLI package without deploy provenance", () => {
  const on = () => vi.stubEnv(REQUIRE_CLI_PROVENANCE_ENV, "1");

  it("known positive: a deploy-archive package with a full commit and histories is healthy", async () => {
    on();
    vi.stubEnv("OPENCADRE_VERSION", FULL.slice(0, 8));
    serveBuild(goodBuild());
    expect(await health()).toEqual({ status: 200, body: { status: "ok", version: FULL.slice(0, 8) } });
  });

  it("a git-provenance package (a build from a checkout) is healthy too", async () => {
    on();
    serveBuild({ ...goodBuild(), provenance: "git" });
    expect((await health()).status).toBe(200);
  });

  const failing: Array<[string, () => void, RegExp]> = [
    ["provenance none (the 2026-10-06 production shape)", () => serveBuild(noneBuild()), /provenance is "none"/],
    ["provenance none with a full commit and histories (provenance alone)", () => serveBuild({ ...goodBuild(), provenance: "none" }), /provenance is "none"/],
    ["a short commit", () => serveBuild({ ...goodBuild(), commit: FULL.slice(0, 12) }), /commit is not a full 40-hex sha/],
    ["a null commit", () => serveBuild({ ...goodBuild(), commit: null }), /commit is not a full 40-hex sha/],
    ["an uppercase commit", () => serveBuild({ ...goodBuild(), commit: FULL.toUpperCase() }), /commit is not a full 40-hex sha/],
    ["one helper's history empty", () => serveBuild({ ...goodBuild(), officialHistory: { "a.mjs": [HASH], "b.mjs": [] } }), /officialHistory is empty for b\.mjs/],
    ["one helper's history missing", () => serveBuild({ ...goodBuild(), officialHistory: { "a.mjs": [HASH] } }), /officialHistory is empty for b\.mjs/],
    // Review of #718 (049a): a non-empty list of non-hashes matches no helper either, so it recreates the regression.
    ["a history entry that is null", () => serveBuild({ ...goodBuild(), officialHistory: { "a.mjs": [null], "b.mjs": [HASH] } }), /officialHistory has entries that are not sha256 hex for a\.mjs/],
    ["a history entry that is not a sha256", () => serveBuild({ ...goodBuild(), officialHistory: { "a.mjs": [HASH], "b.mjs": ["not-a-sha256"] } }), /officialHistory has entries that are not sha256 hex for b\.mjs/],
    ["an uppercase history entry", () => serveBuild({ ...goodBuild(), officialHistory: { "a.mjs": [HASH.toUpperCase()], "b.mjs": [HASH] } }), /officialHistory has entries that are not sha256 hex for a\.mjs/],
    ["no helpers at all", () => serveBuild({ ...goodBuild(), helpers: {}, officialHistory: {} }), /names no helpers/],
    ["no CLI package (fail closed)", () => serve(null), /no CLI package/],
    ["a package without build.json", () => serve(tgz([{ name: "package/package.json", body: "{}" }])), /has no build\.json/],
    ["a package that is not a tarball", () => serve(Buffer.from("not a tarball")), /not a readable tarball/],
  ];
  for (const [name, arrange, why] of failing) {
    it(`503 for ${name}`, async () => {
      on();
      arrange();
      const r = await health();
      expect(r.status).toBe(503);
      expect(r.body.status).toBe("error");
      expect(String(r.body.error)).toMatch(/^CLI package provenance: /);
      expect(String(r.body.error)).toMatch(why);
    });
  }

  it("503 when the deployed OPENCADRE_VERSION (a short sha) is not a prefix of the package's commit", async () => {
    on();
    vi.stubEnv("OPENCADRE_VERSION", "fedcba9");
    serveBuild(goodBuild());
    const r = await health();
    expect(r.status).toBe(503);
    expect(String(r.body.error)).toMatch(/commit 0123456789ab.* is not the deployed version fedcba9/);
  });

  it("a non-sha OPENCADRE_VERSION (deploy-vps.sh --rollback sets \"rollback\") skips only the version comparison", async () => {
    // The rollback path re-runs the previous image with VERSION=rollback. That image passed this guard when it was
    // deployed; failing it here would turn "roll back" into "the hub is down".
    on();
    for (const version of ["rollback", "dev", ""]) {
      vi.stubEnv("OPENCADRE_VERSION", version);
      serveBuild(goodBuild());
      expect((await health()).status, version).toBe(200);
      serveBuild(noneBuild());
      expect((await health()).status, version).toBe(503);
    }
  });

  it("only exactly 1 turns it on", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      vi.stubEnv(REQUIRE_CLI_PROVENANCE_ENV, value);
      serveBuild(noneBuild());
      expect((await health()).status, JSON.stringify(value)).toBe(200);
    }
  });

  it("the database check still comes first", async () => {
    on();
    serveBuild(goodBuild());
    const { db } = await import("../src/db.js");
    const spy = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });
    const r = await health();
    spy.mockRestore();
    expect(r).toEqual({ status: 503, body: { status: "error", error: "database unavailable" } });
  });
});

describe("startup log", () => {
  it("logs the reason as an error with the flag on, and nothing with it off", async () => {
    const { setLogSink } = await import("../src/log.js");
    const { reportCliProvenanceAtStartup } = await import("../src/cli-provenance-guard.js");
    const lines: Array<{ level: string; line: string }> = [];
    const restore = setLogSink((line, level) => lines.push({ level, line }));
    try {
      serveBuild(noneBuild());
      expect(reportCliProvenanceAtStartup({})).toBeNull();
      expect(lines).toEqual([]);
      expect(reportCliProvenanceAtStartup({ [REQUIRE_CLI_PROVENANCE_ENV]: "1" })).toMatch(/provenance is "none"/);
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("error");
      expect(JSON.parse(lines[0].line).msg).toMatch(/^\/health will answer 503: CLI package provenance: provenance is "none"/);
    } finally {
      restore();
    }
  });
});

describe("flag unset: behaviour unchanged", () => {
  it("provenance none is healthy (self-hosters build from plain checkouts)", async () => {
    vi.stubEnv("OPENCADRE_VERSION", "abc1234");
    serveBuild(noneBuild());
    expect(await health()).toEqual({ status: 200, body: { status: "ok", version: "abc1234" } });
  });

  it("no CLI package at all is healthy", async () => {
    serve(null);
    expect((await health()).status).toBe(200);
  });

  it("cliProvenanceProblem reads the flag and version from the env it is given", () => {
    serve(null);
    expect(cliProvenanceProblem({})).toBeNull();
    expect(cliProvenanceProblem({ [REQUIRE_CLI_PROVENANCE_ENV]: "1" })).toMatch(/no CLI package/);
  });
});
