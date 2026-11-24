import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectorUpdateNotice } from "../scripts/opencadre-update-notice.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const stamp = "abcdef012345";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "upgrade-notice-"));
  const dir = join(root, ".gen", "123456789abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".generation.json"), JSON.stringify({ id: "123456789abc", helpers: { "opencadre-awareness.mjs": hash("old") } }));
  // The installed file its metadata names, so the install is intact (the notice hashes it: addendum §2.2).
  writeFileSync(join(dir, "opencadre-awareness.mjs"), "old");
  // `home` and `env` keep the update-policy read (PR-E1) inside this fixture: never the real home or this run's env.
  return { root, home: root, env: {}, entryUrl: pathToFileURL(join(dir, "opencadre-awareness.mjs")), stateDir: join(root, "state"), base: "https://hub.example.test", client: "codex", now: 10_000_000 };
}
function manifest(current = "new") {
  return { tarball: { stamp, sha256: stamp + "a".repeat(52), bytes: 4096, url: `https://other.example.test/cli/${stamp}/opencadre-cli.tgz` }, command: `npx -y https://other.example.test/cli/${stamp}/opencadre-cli.tgz connect --upgrade`, helpers: { "opencadre-awareness.mjs": hash(current) } };
}
afterEach(() => vi.restoreAllMocks());
describe("customer connector update notices", { timeout: 20_000 }, () => {
  it("checks the configured hub without credentials and reports the running generation and immutable command", async () => {
    const f = fixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
    const text = await connectorUpdateNotice({ ...f, fetcher });
    expect(text).toContain("123456789abc");
    expect(text).toContain(stamp);
    expect(text).toContain(`npx -y ${f.base}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`);
    expect(text).not.toContain("other.example.test");
    expect(text).toContain("optional");
    expect(text).toContain("save");
    expect(text).toContain("Trust");
    expect(fetcher.mock.calls[0][0]).toBe(`${f.base}/cli/manifest.json`);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
  it("shares throttling across chats and checks again after six hours without nagging about the same build", async () => {
    const f = fixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
    expect(await connectorUpdateNotice({ ...f, fetcher })).not.toBe("");
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 60_000 })).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 6 * 3600_000 + 1 })).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 24 * 3600_000 + 1 })).not.toBe("");
  });
  it("does not call a different bundle unsupported or treat current helper hashes as outdated", async () => {
    const f = fixture();
    expect(await connectorUpdateNotice({ ...f, fetcher: async () => new Response(JSON.stringify(manifest("old"))) })).toBe("");
  });
  it("does not block offline work, and throttles unreachable manifest checks", async () => {
    const f = fixture();
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    expect(await connectorUpdateNotice({ ...f, fetcher })).toBe("");
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 60_000 })).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...manifest(), tarball: { ...manifest().tarball, sha256: "f".repeat(64) } },
    { ...manifest(), helpers: {} },
    { ...manifest(), command: "npx -y https://hub.example.test/cli/opencadre-cli.tgz connect --upgrade" },
  ])("never invents an unstamped command from a malformed manifest", async (body) => {
    expect(await connectorUpdateNotice({ ...fixture(), fetcher: async () => new Response(JSON.stringify(body)) })).toBe("");
  });
  it("never places shell syntax, credentials, query strings or an untrusted client in the command", async () => {
    for (const base of ["https://hub.example.test/x';whoami", "https://user:password@hub.example.test", "https://hub.example.test/?x=bad", "https://x$evil.example.test", "https://x`whoami`.example.test"]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
      expect(await connectorUpdateNotice({ ...fixture(), base, fetcher })).toBe("");
      expect(fetcher).not.toHaveBeenCalled();
    }
    const text = await connectorUpdateNotice({ ...fixture(), client: "codex;whoami", fetcher: async () => new Response(JSON.stringify(manifest())) });
    expect(text).not.toContain("whoami");
  });
  it("reports unknown legacy metadata as unknown rather than claiming it is current, and leaves repository hooks alone", async () => {
    const f = fixture();
    writeFileSync(join(f.root, ".gen", "123456789abc", ".generation.json"), "broken");
    const text = await connectorUpdateNotice({ ...f, fetcher: async () => new Response(JSON.stringify(manifest())) });
    expect(text).toContain("unknown");
    expect(text).not.toContain("unsupported");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
    expect(await connectorUpdateNotice({ ...f, entryUrl: pathToFileURL(join(f.root, "examples", "hooks", "opencadre-awareness.mjs")), fetcher })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("recovers corrupt advisory state and does not permanently stop checking after a crashed claim", async () => {
    const f = fixture();
    mkdirSync(f.stateDir, { recursive: true });
    const tag = hash(`${f.base}\n${f.root}`).slice(0, 24);
    const stateFile = join(f.stateDir, `opencadre-update-${tag}.json`);
    writeFileSync(stateFile, "null");
    const bucket = Math.floor(f.now / (6 * 3600_000));
    writeFileSync(`${stateFile}.${bucket}.lock`, "crashed advisory");
    writeFileSync(`${stateFile}.${bucket + 1}.lock`, "crashed advisory");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
    expect(await connectorUpdateNotice({ ...f, fetcher })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 6 * 3600_000 + 1 })).toBe("");
    expect(await connectorUpdateNotice({ ...f, fetcher, now: f.now + 12 * 3600_000 + 1 })).toContain("connector update available");
  });
  it("simultaneous chats deliver only one advisory for the same install", async () => {
    const f = fixture();
    let release!: () => void;
    const ready = new Promise<void>((r) => release = r);
    const fetcher = vi.fn(async () => { await ready; return new Response(JSON.stringify(manifest())); });
    const first = connectorUpdateNotice({ ...f, fetcher });
    const second = connectorUpdateNotice({ ...f, fetcher });
    release();
    const replies = await Promise.all([first, second]);
    expect(replies.filter(Boolean)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous starts on opposite sides of a six-hour boundary", async () => {
    const f = fixture();
    const boundary = 6 * 3600_000;
    let release!: () => void;
    const ready = new Promise<void>((r) => release = r);
    const fetcher = vi.fn(async () => { await ready; return new Response(JSON.stringify(manifest())); });
    const first = connectorUpdateNotice({ ...f, now: boundary - 1, fetcher });
    const second = connectorUpdateNotice({ ...f, now: boundary + 1, fetcher });
    release();
    expect((await Promise.all([first, second])).filter(Boolean)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("names the installed and current identity: the bundle, that its files match its record, and the hub's build", async () => {
    const f = fixture();
    const body = { ...manifest(), inputsDigest: "9".repeat(64), imports: {} };
    const text = await connectorUpdateNotice({ ...f, fetcher: async () => new Response(JSON.stringify(body)) });
    expect(text).toContain("running bundle 123456789abc (files match its install record); hub package abcdef012345, build 999999999999.");
    expect(text).toContain("open chats keep the helpers they started with until they are restarted");
  });
  it("a modified or incomplete install is never offered as an optional update (addendum §2.2)", async () => {
    const f = fixture();
    writeFileSync(join(f.root, ".gen", "123456789abc", "opencadre-awareness.mjs"), "edited on this machine");
    const text = await connectorUpdateNotice({ ...f, fetcher: async () => new Response(JSON.stringify(manifest())) });
    expect(text).toContain("do not match their install record");
    expect(text).toContain("some files differ from its install record or are missing");
    expect(text).not.toContain("update available (optional)");
    expect(text).toContain(`npx -y ${f.base}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`);
  });
  it("a plain-http hub that is not loopback gets no request and no notice (the shared reader needs https)", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest())));
    const f = { ...fixture(), base: "http://hub.example.test" };
    expect(await connectorUpdateNotice({ ...f, fetcher })).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(f.stateDir)).toBe(false);
  });
  it("cancels oversized streams before buffering the full response", async () => {
    let chunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 12) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    expect(await connectorUpdateNotice({ ...fixture(), fetcher: async () => new Response(stream) })).toBe("");
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(12);
  });

});
