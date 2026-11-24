// PR-E1: the one bounded reader of GET <hub>/cli/manifest.json (scripts/opencadre-update-check.mjs readCliManifest),
// which doctor, `connect --upgrade`, `update --check` and the advisory notice all use (plan PR-E §5.2).
//
// Each bound is shown with REAL fetch against a real server on 127.0.0.1 where the bound is about the network (redirect,
// oversize stream, stalled headers, stalled body), and its falsifier is named: removing `redirect: "error"`, the byte cap
// or the body deadline turns the matching test red.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { isolatedCliEnv } from "./helpers/isolated-cli-env.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";
import { MANIFEST_MAX_BYTES, manifestHub, readCliManifest, validateManifest } from "../scripts/opencadre-update-check.mjs";
import { fetchCliManifest } from "../cli/lib/doctor.mjs";

const stamp = "0123456789ab";
const good = (host = "https://public.example.test") => ({
  inputsDigest: "e".repeat(64), imports: { "a.mjs": ["b.mjs"] }, helpers: { "a.mjs": "1".repeat(64), "b.mjs": "2".repeat(64) },
  officialHistory: { "a.mjs": ["1".repeat(64)] },
  tarball: { stamp, sha256: stamp + "f".repeat(52), bytes: 2048, url: `${host}/cli/${stamp}/opencadre-cli.tgz` },
  command: `npx -y ${host}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`,
});

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let hub: string;
const routes = new Map<string, Route>();
const seen: { url: string; authorization?: string }[] = [];
let lastBytesSent = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    const prefix = (req.url ?? "").split("/cli/")[0];
    const route = routes.get(prefix);
    if (route) return route(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  routes.set("/good", (_, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(good())); });
  routes.set("/redirect", (_, res) => { res.writeHead(302, { location: `${hub}/good/cli/manifest.json` }).end(); });
  routes.set("/huge", (_, res) => {
    // No content-length: the cap has to be enforced on the stream. 12 MiB offered in 256 KiB chunks.
    res.setHeader("content-type", "application/json");
    lastBytesSent = 0;
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    let left = 48;
    const pump = () => {
      while (left > 0) {
        left--;
        lastBytesSent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    res.on("close", () => { left = 0; });
    pump();
  });
  routes.set("/declared-huge", (_, res) => { res.writeHead(200, { "content-length": String(MANIFEST_MAX_BYTES + 1), "content-type": "application/json" }); res.write("{"); });
  routes.set("/stall-headers", () => { /* never answers */ });
  routes.set("/stall-body", (_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{\"tarball\":"); });
  routes.set("/not-json", (_, res) => { res.end("<html>"); });
  routes.set("/error", (_, res) => { res.writeHead(503).end("{}"); });
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

describe("readCliManifest: bounds, with real fetch on 127.0.0.1", () => {
  it("a well-formed answer: the command is rebuilt from the hub ASKED, never the answer's command or url", async () => {
    const read = await readCliManifest(`${hub}/good`);
    expect(read).toMatchObject({ ok: true, stamp, bytes: 2048, command: `npx -y ${hub}/good/cli/${stamp}/opencadre-cli.tgz connect --upgrade` });
    expect(JSON.stringify(read)).not.toContain("public.example.test");
    expect(read.ok && read.build).toEqual({ inputsDigest: "e".repeat(64), imports: { "a.mjs": ["b.mjs"] }, helpers: good().helpers });
    expect(seen.at(-1)).toEqual({ url: "/good/cli/manifest.json", authorization: undefined });
  });
  it("a redirect is rejected, not followed (falsifier: drop redirect: \"error\")", async () => {
    const before = seen.length;
    const read = await readCliManifest(`${hub}/redirect`);
    expect(read).toMatchObject({ ok: false, kind: "redirect" });
    expect(!read.ok && read.reason).toMatch(/redirect, which is not followed/);
    // The redirect target was never requested.
    expect(seen.slice(before).map((s) => s.url)).toEqual(["/redirect/cli/manifest.json"]);
  });
  it("a stream over 4 MiB is cancelled before it is all sent (falsifier: drop the cap)", async () => {
    const read = await readCliManifest(`${hub}/huge`);
    expect(read).toMatchObject({ ok: false, kind: "too-large" });
    await new Promise((r) => setTimeout(r, 200));
    expect(lastBytesSent).toBeLessThan(12 * 1024 * 1024);
  });
  it("a declared content-length over the cap is refused before reading", async () => {
    expect(await readCliManifest(`${hub}/declared-huge`)).toMatchObject({ ok: false, kind: "too-large" });
  });
  it("stalled headers and a stalled body both hit ONE deadline (falsifier: a deadline on the headers only)", async () => {
    for (const route of ["/stall-headers", "/stall-body"]) {
      const started = Date.now();
      const read = await readCliManifest(`${hub}${route}`, { timeoutMs: 400 });
      expect(read, route).toMatchObject({ ok: false, kind: "timeout" });
      expect(Date.now() - started, route).toBeLessThan(5000);
    }
  });
  it("not JSON, an HTTP error and an unreachable hub are each a plain refusal", async () => {
    expect(await readCliManifest(`${hub}/not-json`)).toMatchObject({ ok: false, kind: "malformed", reason: "the answer is not JSON" });
    expect(await readCliManifest(`${hub}/error`)).toMatchObject({ ok: false, kind: "http", reason: "HTTP 503" });
    expect(await readCliManifest("http://127.0.0.1:9", { timeoutMs: 3000 })).toMatchObject({ ok: false });
  });
  it("a stubbed fetcher that ignores the abort signal still meets the deadline", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const read = await readCliManifest("https://hub.example.test", { timeoutMs: 100, fetcher });
    expect(read).toMatchObject({ ok: false, kind: "timeout" });
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); } });
    const slow = await readCliManifest("https://hub.example.test", { timeoutMs: 100, fetcher: async () => new Response(body) });
    expect(slow).toMatchObject({ ok: false, kind: "timeout" });
  });
  it("a fetcher returning a manual redirect is a redirect too", async () => {
    const fetcher = async () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example.test/" } });
    expect(await readCliManifest("https://hub.example.test", { fetcher })).toMatchObject({ ok: false, kind: "redirect" });
  });
  it("the request carries no credential, asks for no cache, and refuses redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(good())));
    await readCliManifest("https://hub.example.test/", { fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/cli/manifest.json");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(init).not.toHaveProperty("headers");
  });
});

describe("https, unless the hub is loopback", () => {
  it.each(["https://hub.example.test", "http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "https://hub.example.test/base/"])("%s is accepted", (base) => {
    expect(manifestHub(base).ok).toBe(true);
  });
  it.each([
    ["http://hub.example.test", /not https/],
    ["http://192.168.1.20:3000", /not https/],
    ["http://127.0.0.2", /not https/],
    ["https://user:pw@hub.example.test", /plain/],
    ["https://hub.example.test/?x=1", /plain/],
    ["https://x$y.example.test", /./],
    ["ftp://hub.example.test", /plain/],
    ["not a url", /not a URL/],
  ])("%s is refused before any request", async (base, reason) => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const read = await readCliManifest(base, { fetcher });
    expect(read).toMatchObject({ ok: false, kind: "invalid-hub" });
    expect(!read.ok && read.reason).toMatch(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("validateManifest: the shape", () => {
  const mutate = (fn: (m: ReturnType<typeof good>) => void) => { const m = good(); fn(m); return m; };
  it.each([
    ["no tarball", mutate((m) => { delete (m as Partial<typeof m>).tarball; })],
    ["a short stamp", mutate((m) => { m.tarball.stamp = "abc"; })],
    ["a sha256 not starting with the stamp", mutate((m) => { m.tarball.sha256 = "f".repeat(64); })],
    ["bytes missing", mutate((m) => { delete (m.tarball as Partial<typeof m.tarball>).bytes; })],
    ["bytes zero", mutate((m) => { m.tarball.bytes = 0; })],
    ["bytes over 16 MiB", mutate((m) => { m.tarball.bytes = 16 * 1024 * 1024 + 1; })],
    ["bytes not an integer", mutate((m) => { m.tarball.bytes = 1.5; })],
    ["url missing", mutate((m) => { delete (m.tarball as Partial<typeof m.tarball>).url; })],
    ["url for another stamp", mutate((m) => { m.tarball.url = "https://h.example.test/cli/ffffffffffff/opencadre-cli.tgz"; })],
    ["the bare url", mutate((m) => { m.tarball.url = "https://h.example.test/cli/opencadre-cli.tgz"; })],
    ["url with a query", mutate((m) => { m.tarball.url += "?x=1"; })],
    ["a command without the stamped path", mutate((m) => { m.command = "npx -y https://h.example.test/cli/opencadre-cli.tgz connect --upgrade"; })],
    ["helpers not sha256", mutate((m) => { m.helpers = { "a.mjs": "nope" } as typeof m.helpers; })],
    ["helpers empty", mutate((m) => { m.helpers = {} as typeof m.helpers; })],
    ["imports not lists", mutate((m) => { (m as Record<string, unknown>).imports = { "a.mjs": "b.mjs" }; })],
    ["inputsDigest not sha256", mutate((m) => { m.inputsDigest = "xyz"; })],
    ["officialHistory not sha256 lists", mutate((m) => { (m as Record<string, unknown>).officialHistory = { "a.mjs": ["nope"] }; })],
    ["an array", [good()]],
  ])("%s is malformed", (_, body) => {
    expect(validateManifest(body)).toEqual({ ok: false, reason: "the answer is not a CLI manifest" });
  });
  it("absent build fields leave a usable command with build: null (doctor's existing contract)", () => {
    const m = good() as Record<string, unknown>;
    for (const k of ["inputsDigest", "imports", "helpers", "officialHistory"]) delete m[k];
    expect(validateManifest(m)).toMatchObject({ ok: true, stamp, helpers: null, build: null });
  });
});

describe("the effect on doctor and connect --upgrade of a hub that redirects", () => {
  it("doctor's fetchCliManifest names the redirect", async () => {
    expect(await fetchCliManifest(`${hub}/redirect`)).toMatchObject({ ok: false, kind: "redirect", reason: expect.stringMatching(/redirect, which is not followed/) });
  });
  it("connect --upgrade refuses (exit 2) and writes nothing", async () => {
    const home = tmpDir("oc-redirect-upgrade-");
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), "cli", "bin", "opencadre.mjs"), "connect", "--upgrade", "--hub", `${hub}/redirect`, "--home", home], { env: isolatedCliEnv(home), windowsHide: true });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.stdin.end();
      child.on("close", (code) => resolve({ code, err }));
    });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/redirect, which is not followed/);
    expect(r.err).toMatch(/nothing was changed/);
    expect(existsSync(path.join(home, ".opencadre", "bin"))).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);
});
