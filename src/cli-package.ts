import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { COMPAT_ENTRY, parseCompatPolicy, type CompatPolicy } from "./compat-policy.js";

/**
 * The CLI package the hub serves, read ONCE per (path, mtimeMs, size) into one buffer, and everything the hub says about
 * that package derived from that same buffer: its full sha256, the 12-hex stamp in every printed command, its byte count,
 * and the build.json packed inside it (scripts/pack-cli.mjs, scripts/cli-build-info.mjs).
 *
 * WHY ONE BUFFER (Q1g, ruling 049a §1: "Tie manifest and package to one deployment snapshot"). If the manifest hashed the
 * file on disk and the alias route streamed it separately, a rebuild between the two reads would let the manifest describe
 * bytes nobody downloads. Here the manifest, the stamp and the alias's body are fields of one snapshot object, so they
 * cannot disagree; a new build is a new snapshot, and the old stamp stops resolving at the same moment.
 *
 * The stat is taken on the OPEN file (fstat on the descriptor the bytes are read from), so the cache key and the cached
 * bytes are one file's even if the path is renamed over mid-read; the next request then stats the new file, sees a
 * different key, and reads it.
 */

// Built by scripts/pack-cli.mjs during npm run build; OPENCADRE_CLI_TARBALL overrides the path.
// guard-allow(build-output-path): a file path on the hub, not a URL. tests/cli-unstamped-guard.test.ts lists it.
export const CLI_TARBALL = fileURLToPath(new URL("../dist/cli/opencadre-cli.tgz", import.meta.url));
export const cliTarballFile = () => process.env.OPENCADRE_CLI_TARBALL || CLI_TARBALL;

/** The path inside an npm-packed tarball: npm puts every file under package/. */
export const BUILD_ENTRY = "package/build.json";
export const STAMP_PATTERN = /^[0-9a-f]{12}$/;

export interface CliBuild {
  schema: number;
  [field: string]: unknown;
}

export interface CliPackage {
  file: string;
  mtimeMs: number;
  size: number;
  bytes: Buffer;
  sha256: string;
  stamp: string;
  /** build.json from inside `bytes`, parsed on first use and kept on this snapshot. */
  build(): { ok: true; build: CliBuild } | { ok: false; error: string };
  /** compat-policy.json from inside `bytes` (src/compat-policy.ts), or null when the package has none or it is
   * malformed. Parsed on first use and kept on this snapshot, so it always describes the same bytes as build(). */
  compat(): CompatPolicy | null;
}

let snapshot: CliPackage | null = null;

/** The current package, or null when none is built at the configured path. */
export function currentCliPackage(): CliPackage | null {
  const file = cliTarballFile();
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (snapshot && snapshot.file === file && snapshot.mtimeMs === st.mtimeMs && snapshot.size === st.size) return snapshot;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const held = fstatSync(fd);
    const bytes = readFileSync(fd);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let build: ReturnType<CliPackage["build"]> | null = null;
    let compat: { policy: CompatPolicy | null } | null = null;
    snapshot = {
      file,
      mtimeMs: held.mtimeMs,
      size: held.size,
      bytes,
      sha256,
      stamp: sha256.slice(0, 12),
      build: () => (build ??= readBuild(bytes)),
      compat: () => (compat ??= { policy: readCompat(bytes) }).policy,
    };
    return snapshot;
  } finally {
    closeSync(fd);
  }
}

function readBuild(tgz: Buffer): ReturnType<CliPackage["build"]> {
  let entry: Buffer | null;
  try {
    entry = tarEntry(tgz, BUILD_ENTRY);
  } catch (err) {
    return { ok: false, error: `the CLI package is not a readable tarball (${(err as Error).message})` };
  }
  if (!entry) return { ok: false, error: "the CLI package has no build.json: it was built before build identity existed. Run npm run build on the hub." };
  try {
    const parsed = JSON.parse(entry.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.schema !== "number") throw new Error("not a build record");
    return { ok: true, build: parsed as CliBuild };
  } catch (err) {
    return { ok: false, error: `the CLI package's build.json is malformed (${(err as Error).message})` };
  }
}

function readCompat(tgz: Buffer): CompatPolicy | null {
  try {
    return parseCompatPolicy(tarEntry(tgz, COMPAT_ENTRY));
  } catch {
    return null;
  }
}

/**
 * One regular file's bytes out of a gzipped tar, or null when it isn't there. Pure JS over node:zlib, no dependency.
 *
 * Enough of the format for what npm pack writes (node-tar): 512-byte ustar headers with the name at 0..100, the octal size
 * at 124..136, the type flag at 156 and, for ustar, a prefix at 345..500 joined as `prefix/name`. A pax extended header
 * (type "x") or a GNU long name (type "L") that precedes an entry overrides that entry's name, which is how a path longer
 * than 100 bytes is carried. Global pax headers ("g") and every non-file entry are skipped. Anything that runs past the
 * end of the archive throws, rather than returning a truncated body as if it were the file.
 */
export function tarEntry(tgz: Buffer, wanted: string): Buffer | null {
  const tar = gunzipSync(tgz, { maxOutputLength: 256 * 1024 * 1024 });
  const text = (h: Buffer, from: number, to: number) => {
    const field = h.subarray(from, to);
    const nul = field.indexOf(0);
    return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
  };
  let override: string | null = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const sizeField = text(header, 124, 136).trim();
    const size = sizeField === "" ? 0 : parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad size field at offset ${off}`);
    const body = off + 512;
    if (body + size > tar.length) throw new Error(`entry at offset ${off} runs past the end of the archive`);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = text(header, 257, 263).startsWith("ustar") ? text(header, 345, 500) : "";
    const name = prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100);
    const data = tar.subarray(body, body + size);
    if (type === "x") {
      // "<len> path=<value>\n" records; only the path matters here.
      const path = data.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      override = path ? path[1] : override;
    } else if (type === "L") {
      override = text(data, 0, data.length);
    } else if (type !== "g") {
      const effective = override ?? name;
      override = null;
      if ((type === "0" || type === "7") && effective === wanted) return Buffer.from(data);
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The content-addressed URL of the current package: `<hub>/cli/<stamp>/opencadre-cli.tgz`. The stamp is in the PATH,
 * not a query, so a tool that strips queries cannot turn it back into the bare URL npx has cached. */
export const cliAliasUrl = (hubUrl: string, stamp: string) => `${hubUrl}/cli/${stamp}/opencadre-cli.tgz`;

/** The hub's public origin, no trailing slash: what every printed command is built from. */
export const publicHubUrl = () => (process.env.OPENCADRE_PUBLIC_HUB_URL || "https://hub.opencadre.example").replace(/\/+$/, "");

/** GET /cli/manifest.json's answer: the package's build.json, plus the tarball's digest and address and the one upgrade
 * command, all from one snapshot. 503 while no package is built, or when the package predates build.json. `compat` is
 * ADDITIVE (PLAN-PR-E addendum §1.2): present only when the package carries a valid compat-policy.json, so a package
 * without one, or with a malformed one, serves exactly the fields it served before. */
export function cliManifest(hubUrl: string): { status: number; body: Record<string, unknown> } {
  const pkg = currentCliPackage();
  if (!pkg) return { status: 503, body: { error: "The OpenCadre CLI package isn't built on this hub. Run npm run build on the hub." } };
  const read = pkg.build();
  if (!read.ok) return { status: 503, body: { error: `This hub cannot describe its CLI package: ${read.error}` } };
  const url = cliAliasUrl(hubUrl, pkg.stamp);
  const compat = pkg.compat();
  return {
    status: 200,
    body: {
      ...read.build,
      tarball: { sha256: pkg.sha256, bytes: pkg.bytes.length, stamp: pkg.stamp, url },
      command: `npx -y ${url} connect --upgrade`,
      ...(compat ? { compat } : {}),
    },
  };
}
