// Q1g falsifiers F4 and F5, and the build.json the package carries (PLAN-Q1G.md §2.A, ruling 049a §1).
//
// F5  immutable alias: GET /cli/<own stamp>/opencadre-cli.tgz is the exact bytes with an immutable header; any other stamp,
//     and anything that is not 12 lowercase hex, is 404. Never current bytes under another digest.
// F4  manifest/package agreement: GET /cli/manifest.json's sha256 is the sha256 of the bytes the alias AND the bare route
//     serve; replacing the package moves manifest, stamp and alias together, and the OLD stamp then 404s.
// And the package's build.json: present, its helper hashes are what an install from that package writes, its imports are
// parsed (the approval gate's three siblings), its inputsDigest is re-derivable from the extracted package, and every
// helper's history includes the packed revision.
//
// One real `pack-cli` run (beforeAll) supplies the package, so these are claims about what `npm run build` produces, not
// about a fixture shaped like it. The hub is the real app, in process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpDir } from "./helpers/tmp.js";
import { inputsDigest } from "../scripts/cli-build-info.mjs";

const { app } = await import("../src/rest.js");
const { cliTarballUrl } = await import("../src/connect.js");
const { tarEntry } = await import("../src/cli-package.js");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PUBLIC_HUB = (process.env.OPENCADRE_PUBLIC_HUB_URL || "https://hub.opencadre.example").replace(/\/+$/, "");

let server: http.Server;
let hub: string;
let packed: Buffer; // the bytes pack-cli produced, never modified
let served: string; // the file OPENCADRE_CLI_TARBALL points at; tests may replace it

/** A ustar archive of `entries`, gzipped: enough to hand the hub a package with or without build.json. */
function tgz(entries: Array<{ name: string; body: string; prefix?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body, prefix = "" } of entries) {
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
    h.write(prefix, 345, 155, "utf8");
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Writes `bytes` to the served path and moves its mtime, so the hub's (path, mtime, size) key sees a new file. */
function replaceServed(bytes: Buffer) {
  writeFileSync(served, bytes);
  const later = new Date(Date.now() + Math.floor(Math.random() * 1e6) + 10_000);
  utimesSync(served, later, later);
}

/** Every regular file in a gzipped tar, by its path. The same format tarEntry reads, parsed here independently. */
function untarAll(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const out = new Map<string, Buffer>();
  for (let off = 0; off + 512 <= tar.length; ) {
    const field = (a: number, b: number) => tar.subarray(off + a, off + b).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (!name) break;
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const prefix = field(345, 500);
    if (String.fromCharCode(tar[off + 156]) === "0") out.set(prefix ? `${prefix}/${name}` : name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

beforeAll(async () => {
  const out = tmpDir("oc-cli-manifest-pack-");
  const r = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "pack-cli.mjs"), "--out", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pack-cli failed: ${r.stderr}`);
  packed = readFileSync(path.join(out, "opencadre-cli.tgz"));
  served = path.join(tmpDir("oc-cli-manifest-served-"), "opencadre-cli.tgz");
  copyFileSync(path.join(out, "opencadre-cli.tgz"), served);
  process.env.OPENCADRE_CLI_TARBALL = served;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  hub = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 300_000);

afterAll(async () => {
  delete process.env.OPENCADRE_CLI_TARBALL;
  // Drop keep-alive sockets the fetches left open, so close() does not wait on them (049a saw a 10 s cleanup timeout).
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

// These groups write and read whole packages (~240 KB) and extract ~40 files per test. On this box, under the fleet's
// parallel load, 049a measured them past vitest's 5 s default with no assertion failing, and green at 30 s (#679 review,
// 2026-10-01). The bound is about disk and process latency, not about the logic: each test is fast when the box is quiet.
const IO_BOUND = { timeout: 30_000 };

// F5's negatives for one served stamp: another valid stamp, two malformed ones, and the stamp's case-only variant. Each
// must DIFFER from the stamp, or the arm requests the served stamp itself. An all-digit stamp has no case-only variant
// (toUpperCase() returns it unchanged, seen at 4f250ed3), so that arm is left out for it rather than replaced by a
// different mismatch: a case-insensitive match can only be caught on a stamp that has letters.
const badStamps = (stamp: string) => {
  const upper = stamp.toUpperCase();
  return [
    `${stamp.slice(0, 11)}${stamp[11] === "0" ? "1" : "0"}`,
    stamp === "000000000000" ? "111111111111" : "000000000000",
    "NOTHEX",
    ...(upper !== stamp ? [upper] : []),
    `${stamp}0`,
    stamp.slice(0, 11),
  ];
};

const manifest = async () => {
  const res = await fetch(`${hub}/cli/manifest.json`);
  return { res, body: (await res.json()) as Record<string, any> };
};
const get = async (p: string) => {
  const res = await fetch(`${hub}${p}`);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

describe("the packed build.json", IO_BOUND, () => {
  it("is in the package, at package/build.json, and describes the packed tree", async () => {
    const files = untarAll(packed);
    const build = JSON.parse(files.get("package/build.json")!.toString("utf8"));
    expect(build.schema).toBe(1);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(build.commit).toBe(head);
    // inputsDigest re-derived from the EXTRACTED package: every packed file but build.json itself.
    const extracted = [...files].filter(([p]) => p !== "package/build.json").map(([p, bytes]) => ({ path: p.replace(/^package\//, ""), bytes }));
    expect(build.inputsDigest).toBe(inputsDigest(extracted));
    // dirty names repo paths of packed inputs only.
    for (const p of build.dirty) expect(p).toMatch(/^(cli|scripts|examples)\//);
  });

  it("helper hashes are the sha256 of exactly what installHelpers FROM THIS PACKAGE writes", async () => {
    const root = tmpDir("oc-cli-manifest-extract-");
    for (const [p, bytes] of untarAll(packed)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), bytes);
    }
    const build = JSON.parse(readFileSync(path.join(root, "package", "build.json"), "utf8"));
    const { HELPERS } = await import(pathToFileURL(path.join(root, "package", "lib", "helpers.mjs")).href);
    const { installHelpers, generationPath, readPointer } = await import(pathToFileURL(path.join(root, "package", "lib", "generations.mjs")).href);
    const bin = tmpDir("oc-cli-manifest-bin-");
    installHelpers(bin);
    // Since Q1g PR-2 the helpers are written into one generation folder, named by the package's own inputsDigest.
    expect(readPointer(bin).id).toBe(build.inputsDigest.slice(0, 12));
    const gen = generationPath(bin, readPointer(bin).id);
    const written = Object.fromEntries(Object.keys(HELPERS).map((n) => [n, sha(readFileSync(path.join(gen, ...n.split("/"))))]));
    expect(build.helpers).toEqual(written);
  });

  it("imports are parsed: the approval gate imports config, secrets and the hook dialect", () => {
    const build = JSON.parse(untarAll(packed).get("package/build.json")!.toString("utf8"));
    expect(build.imports["opencadre-approval-gate.mjs"]).toEqual(expect.arrayContaining(["opencadre-config.mjs", "opencadre-secrets.mjs", "opencadre-hook-dialect.mjs"]));
    expect(build.imports["opencode-plugin/index.js"]).toEqual(expect.arrayContaining(["opencode-plugin/clearance.js", "opencode-plugin/mail.js"]));
  });

  it("every helper's official history includes the packed revision, and a long-lived helper has more than one", () => {
    const build = JSON.parse(untarAll(packed).get("package/build.json")!.toString("utf8"));
    for (const [name, hash] of Object.entries(build.helpers)) expect(build.officialHistory[name], name).toContain(hash);
    // A shallow clone legitimately holds fewer revisions (scripts/cli-build-info.mjs), so the depth claim needs full history.
    const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).stdout.trim() === "true";
    if (!shallow) expect(build.officialHistory["opencadre-approval-gate.mjs"].length).toBeGreaterThan(1);
  });
});

describe("F5: the immutable alias", IO_BOUND, () => {
  it("serves its own stamp's exact bytes with an immutable header", async () => {
    replaceServed(packed);
    const stamp = sha(packed).slice(0, 12);
    const { res, bytes } = await get(`/cli/${stamp}/opencadre-cli.tgz`);
    expect(res.status).toBe(200);
    expect(sha(bytes)).toBe(sha(packed));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("every negative stamp differs from the stamp it is built from, whatever that stamp's shape", () => {
    // An all-digit stamp has no case: `toUpperCase()` returned it unchanged, so the negative arm requested the CURRENT
    // stamp and got 200 (seen at 4f250ed3). These pin the builder on both shapes, independent of today's package hash.
    for (const stamp of ["012345678901", "000000000000", "abcdef012345", "0123456789ab"]) {
      const bad = badStamps(stamp);
      for (const b of bad) expect(b, `${stamp} -> ${b}`).not.toBe(stamp);
      // The case-only variant is kept exactly when one exists, so a case-insensitive match is still caught.
      expect(bad.includes(stamp.toUpperCase()), stamp).toBe(/[a-f]/.test(stamp));
    }
  });

  it("answers 404, never the current bytes, for any other stamp or a malformed one", async () => {
    replaceServed(packed);
    const stamp = sha(packed).slice(0, 12);
    for (const bad of badStamps(stamp)) {
      // Asserted before the request: a negative equal to the served stamp would prove nothing (it is a 200 by contract).
      expect(bad, "a negative stamp must differ from the served one").not.toBe(stamp);
      const { res, bytes } = await get(`/cli/${bad}/opencadre-cli.tgz`);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get("content-type"), bad).toMatch(/application\/json/);
      expect(bytes.includes(packed.subarray(0, 64)), bad).toBe(false);
    }
  });
});

describe("F4: the manifest and the package are one snapshot", IO_BOUND, () => {
  it("the manifest's digest is the sha256 of what the alias, the bare route and the bare route's ?v= serve", async () => {
    replaceServed(packed);
    const { res, body } = await manifest();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const { tarball } = body;
    expect(tarball.sha256).toBe(sha(packed));
    expect(tarball.bytes).toBe(packed.length);
    expect(tarball.stamp).toBe(tarball.sha256.slice(0, 12));
    expect(tarball.url).toBe(`${PUBLIC_HUB}/cli/${tarball.stamp}/opencadre-cli.tgz`);
    expect(body.command).toBe(`npx -y ${tarball.url} connect --upgrade`);
    for (const p of [`/cli/${tarball.stamp}/opencadre-cli.tgz`, "/cli/opencadre-cli.tgz", `/cli/opencadre-cli.tgz?v=${tarball.stamp}`]) {
      const got = await get(p);
      expect(got.res.status, p).toBe(200);
      expect(sha(got.bytes), p).toBe(tarball.sha256);
    }
    // The build fields are the package's own build.json, verbatim.
    const build = JSON.parse(untarAll(packed).get("package/build.json")!.toString("utf8"));
    const { tarball: _t, command: _c, compat, ...fromManifest } = body;
    expect(fromManifest).toEqual(build);
    // The additive `compat` field (PLAN-PR-E addendum §1.2) is the same snapshot's own compat-policy.json, verbatim.
    expect(compat).toEqual(JSON.parse(untarAll(packed).get("package/compat-policy.json")!.toString("utf8")));
    // Every command the hub prints uses the same snapshot's stamp.
    expect(cliTarballUrl("https://h.example.test")).toBe(`https://h.example.test/cli/${tarball.stamp}/opencadre-cli.tgz`);
  });

  it("replacing the package moves manifest, stamp and alias together, and the OLD stamp then 404s", async () => {
    replaceServed(packed);
    const before = (await manifest()).body.tarball;
    // Same files, different bytes: the build a rebuild with another gzip level would produce.
    const rebuilt = gzipSync(gunzipSync(packed), { level: 1 });
    expect(sha(rebuilt)).not.toBe(sha(packed));
    replaceServed(rebuilt);
    const after = (await manifest()).body;
    expect(after.tarball.sha256).toBe(sha(rebuilt));
    expect(after.tarball.stamp).not.toBe(before.stamp);
    expect(after.command).toContain(`/cli/${after.tarball.stamp}/opencadre-cli.tgz`);
    const fresh = await get(`/cli/${after.tarball.stamp}/opencadre-cli.tgz`);
    expect(fresh.res.status).toBe(200);
    expect(sha(fresh.bytes)).toBe(sha(rebuilt));
    expect(sha((await get("/cli/opencadre-cli.tgz")).bytes)).toBe(sha(rebuilt));
    const stale = await get(`/cli/${before.stamp}/opencadre-cli.tgz`);
    expect(stale.res.status).toBe(404);
    replaceServed(packed);
  });

  it("is 503, and the alias 404, while no package is built", async () => {
    process.env.OPENCADRE_CLI_TARBALL = path.join(tmpDir("oc-cli-manifest-none-"), "opencadre-cli.tgz");
    try {
      const { res, body } = await manifest();
      expect(res.status).toBe(503);
      expect(body.error).toMatch(/npm run build/);
      expect((await get(`/cli/${sha(packed).slice(0, 12)}/opencadre-cli.tgz`)).res.status).toBe(404);
    } finally {
      process.env.OPENCADRE_CLI_TARBALL = served;
    }
  });

  it("is 503 with a clear message for a package built before build.json, or one that is not a tarball", async () => {
    replaceServed(tgz([{ name: "package/package.json", body: "{}" }]));
    let got = await manifest();
    expect(got.res.status).toBe(503);
    expect(got.body.error).toMatch(/no build\.json.*built before build identity existed/);
    replaceServed(Buffer.from("not a tarball"));
    got = await manifest();
    expect(got.res.status).toBe(503);
    expect(got.body.error).toMatch(/not a readable tarball/);
    replaceServed(packed);
  });
});

describe("tarEntry", () => {
  it("joins a ustar prefix, and follows a pax path over the header's own name", () => {
    expect(tarEntry(tgz([{ name: "build.json", prefix: "package", body: '{"schema":1}' }]), "package/build.json")?.toString()).toBe('{"schema":1}');
    const pax = "27 path=package/build.json\n";
    const withPax = tgz([
      { name: "PaxHeader/x", body: pax },
      { name: "package/other.json", body: '{"schema":2}' },
    ]);
    // Re-type the first entry as a pax header ("x"): the checksum is not verified by the reader, the type flag is.
    const tar = gunzipSync(withPax);
    tar[156] = "x".charCodeAt(0);
    expect(tarEntry(gzipSync(tar), "package/build.json")?.toString()).toBe('{"schema":2}');
    expect(tarEntry(gzipSync(tar), "package/other.json")).toBeNull();
  });

  it("throws on an archive that ends inside an entry, rather than returning a truncated body", () => {
    const tar = gunzipSync(tgz([{ name: "package/build.json", body: "x".repeat(2000) }]));
    expect(() => tarEntry(gzipSync(tar.subarray(0, 1024)), "package/build.json")).toThrow(/past the end/);
  });
});
