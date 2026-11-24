import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { reportConnectorBuild } from "../scripts/opencadre-update-notice.mjs";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "build-report-"));
  const dir = join(root, ".gen", "123456789abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencadre-config.mjs"), "original");
  const meta = JSON.stringify({ helpers: { "opencadre-config.mjs": hash("original") } });
  writeFileSync(join(dir, ".generation.json"), meta);
  return { root, dir, meta, base: "https://hub.example.test", credential: "dev_" + "c".repeat(48), client: "codex", component: "hooks", stateDir: join(root, "state"), entryUrl: pathToFileURL(join(dir, "opencadre-awareness.mjs")), now: 100000000 };
}
describe("optional computer inventory", () => {
  it("reports hashes without paths or credential in the body; preserves local bytes and throttles even an older hub's 404", async () => {
    const f = fixture();
    const fetcher = vi.fn(async () => new Response("not supported", { status: 404 }));
    await reportConnectorBuild({ ...f, fetcher });
    await reportConnectorBuild({ ...f, fetcher, now: f.now + 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as any;
    expect(url).toBe(f.base + "/v1/devices/connector-build");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body)).toMatchObject({ schema: 1, integrity: "matches-metadata", helpers: { "opencadre-config.mjs": hash("original") } });
    expect(options.body.includes(f.credential) || options.body.includes(f.root)).toBe(false);
    expect(readFileSync(join(f.dir, ".generation.json"), "utf8")).toBe(f.meta);
    await reportConnectorBuild({ ...f, fetcher, now: f.now + 6 * 3600000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("hashes actual changed files and separates hook and proxy observations", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "opencadre-config.mjs"), "edited");
    const fetcher = vi.fn(async () => new Response("{}"));
    await reportConnectorBuild({ ...f, fetcher });
    await reportConnectorBuild({ ...f, fetcher, component: "proxy" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toMatchObject({ integrity: "modified-or-missing", helpers: { "opencadre-config.mjs": hash("edited") } });
  });
  it("rejects unsafe metadata paths without reading them, and is quiet offline", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, ".generation.json"), JSON.stringify({ helpers: { "../private.mjs": hash("secret") } }));
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    await expect(reportConnectorBuild({ ...f, fetcher })).resolves.toBeUndefined();
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toMatchObject({ integrity: "unknown", helpers: null });
  });
  it("does not contact unsafe hubs, repository sources, or named-agent credentials", async () => {
    const f = fixture();
    const fetcher = vi.fn();
    await reportConnectorBuild({ ...f, fetcher, base: "https://user:pass@example.test" });
    await reportConnectorBuild({ ...f, fetcher, entryUrl: import.meta.url });
    await reportConnectorBuild({ ...f, fetcher, credential: "not-a-device" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
