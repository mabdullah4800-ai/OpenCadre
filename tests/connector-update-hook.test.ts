import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPERS, installTransform, helperSource } from "../cli/lib/helpers.mjs";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

let server: http.Server;
let base: string;
let credentialSeenOnManifest = false;
let manifestReads = 0;
const stamp = "abcdef012345";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/cli/manifest.json") {
      manifestReads++;
      credentialSeenOnManifest ||= Boolean(req.headers.authorization);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tarball: { stamp, sha256: stamp + "a".repeat(52), bytes: 4096, url: `${base}/cli/${stamp}/opencadre-cli.tgz` }, command: `npx -y ${base}/cli/${stamp}/opencadre-cli.tgz connect --upgrade`, helpers: { "opencadre-awareness.mjs": "f".repeat(64) } }));
    } else {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "fixture: no identity" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
function installFixture() {
  const root = mkdtempSync(join(tmpdir(), "notice-hook-"));
  const dir = join(root, ".gen", "123456789abc");
  mkdirSync(dir, { recursive: true });
  const helpers: Record<string, string> = {};
  for (const name of Object.keys(HELPERS)) {
    const text = installTransform(readFileSync(helperSource(name), "utf8"));
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
    helpers[name] = createHash("sha256").update(text).digest("hex");
  }
  writeFileSync(join(dir, ".generation.json"), JSON.stringify({ id: "123456789abc", helpers }));
  return { root, dir };
}
function run(event: string, f: ReturnType<typeof installFixture>) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [join(f.dir, "opencadre-awareness.mjs"), "--client", "claude-code"], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", OPENCADRE_URL: base, OPENCADRE_KEY: "fixture-only", OPENCADRE_HOOK_HOME: f.root, OPENCADRE_AWARENESS_STATE_DIR: join(f.root, "state") },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => out += b);
    child.stderr.on("data", (b) => err += b);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "notice-fixture", cwd: process.cwd() }));
  });
}
describe("installed awareness announces upgrades without working identity", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("appends actionable update advice to the original startup identity refusal", async () => {
    const out = await run("SessionStart", installFixture());
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(text).toContain("could not verify this session's identity (HTTP 401)");
    expect(text).toContain("connector update available (optional)");
    expect(text).toContain(`/cli/${stamp}/opencadre-cli.tgz connect --upgrade`);
    expect(text).not.toContain("fixture-only");
    expect(credentialSeenOnManifest).toBe(false);
  });
  it.each(["UserPromptSubmit", "PostToolUse"])("announces from a safe %s checkpoint even with no fleet digest", async (event) => {
    const out = await run(event, installFixture());
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("connector update available");
  });
  it("under policy off, three live checkpoints make no /cli/ request and identity text is unchanged (PR-E1)", async () => {
    const f = installFixture();
    mkdirSync(join(f.root, ".opencadre"), { recursive: true });
    writeFileSync(join(f.root, ".opencadre", "update-policy.json"), JSON.stringify({ schema: 1, policy: "off", setAt: "2026-10-01T00:00:00.000Z" }));
    const before = manifestReads;
    const start = JSON.parse(await run("SessionStart", f)).hookSpecificOutput.additionalContext;
    expect(start).toContain("could not verify this session's identity (HTTP 401)");
    expect(start).not.toContain("connector update");
    expect(await run("UserPromptSubmit", f)).toBe("");
    expect(await run("PostToolUse", f)).toBe("");
    expect(manifestReads).toBe(before);
    // The known positive: the same install under the default policy reads the manifest.
    const g = installFixture();
    await run("SessionStart", g);
    expect(manifestReads).toBe(before + 1);
  });
  it("does not generate a stop continuation for an update", async () => {
    const before = manifestReads;
    expect(await run("Stop", installFixture())).toBe("");
    expect(manifestReads).toBe(before);
  });
});
