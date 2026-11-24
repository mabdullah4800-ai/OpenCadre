// The CLI tarball route serves from a CONFIG-SUPPLIED path, and the path is very often a
// dot-directory. `send`'s default `dotfiles: "ignore"` refuses any path with a dot segment, so the
// route answered 404 for exactly the installs that had a package built.
//
// MEASURED 2026-09-20, express 5.2.1 / send 1.2.1 (the versions package.json pins), one variable:
//   /dot        -> 404      a path segment starting with "."  (e.g. ".opencadre")
//   /plain      -> 200      identical bytes, no dot-segment
//   /dot-allow  -> 200      the same dot path WITH dotfiles:"allow"
// send/index.js:461 calls `containsDotFile(parts)` and :810 returns true for
// `part.length > 1 && part[0] === "."`.
//
// WHY IT MATTERS AND WHY IT IS NOT A HOLD: the deployed hub serves /app/dist/cli/... (Dockerfile
// WORKDIR /app) — no dot-segment, so PRODUCTION IS UNAFFECTED TODAY. But `.opencadre` is our own
// directory name, so a hub deployed under ~/.opencadre, a self-hosted instance, or any dotted
// workdir serves a route that works in the state nobody tests and 404s in the state that ships.
// The 503 guard hides it further: absent -> 503, and only a built package reaches sendFile at all.
//
// A WITHDRAWN EXPLANATION, kept deliberately. This was first attributed to express's
// `encodeURI(path)` turning `\` into `%5C` on Windows. That is FALSE — send's `decode()`
// (send/index.js:411) `decodeURIComponent`s it straight back, a round-trip pair rather than a
// corruption. The real cause is the dotfile check. The wrong reasoning is recorded in
// docs/research/CODEX-MAIL-WAKE-MEASUREMENT.md §12.3, annotated rather than deleted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";

const { app } = await import("../src/rest.js");

let server: http.Server;
let hub: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  hub = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  delete process.env.OPENCADRE_CLI_TARBALL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A tarball-sized file at `dir/opencadre-cli.tgz`, and the env pointing the route at it. */
function serve(dir: string, bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00])): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencadre-cli.tgz");
  writeFileSync(file, bytes);
  process.env.OPENCADRE_CLI_TARBALL = file;
  return file;
}

describe("GET /cli/opencadre-cli.tgz from a dot-directory", () => {
  it("serves the tarball when the file sits under a dot-directory, as ~/.opencadre does", async () => {
    // The real shape: our own install root is `.opencadre`, so the default `dotfiles:"ignore"`
    // refuses the route for every hub that has actually built a package.
    const file = serve(path.join(tmpDir("oc-dotdir-"), ".opencadre", "bin"));

    const res = await fetch(`${hub}/cli/opencadre-cli.tgz`);
    expect(res.status, "a dot-directory in the served path must not 404 the route").toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
    // Body, not just status: a 200 with the wrong bytes is still a broken install.
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));
    expect(file).toContain(`${path.sep}.opencadre${path.sep}`);
  });

  it("still serves from a plain directory — the control that isolates the dot-segment as the cause", async () => {
    // Same bytes, same route, no dot-segment. Without this arm a failure above could be about the
    // file, the guard, or the route rather than the dot-segment. This is the /plain arm.
    serve(path.join(tmpDir("oc-plaindir-"), "cli", "dist"));

    const res = await fetch(`${hub}/cli/opencadre-cli.tgz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
  });

  it("still answers 503 when no package is built, and now from under a dot-directory too", async () => {
    // The guard must keep working in the newly-served case. `dotfiles:"allow"` widens which paths
    // can be READ; it must not turn a missing file into anything other than the documented 503.
    const missing = path.join(tmpDir("oc-dotmiss-"), ".opencadre", "bin", "opencadre-cli.tgz");
    process.env.OPENCADRE_CLI_TARBALL = missing;

    const res = await fetch(`${hub}/cli/opencadre-cli.tgz`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/npm run build/);
  });
});
