import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The observable fallback must actually REACH someone.
 *
 * explainDeviceCredential produces a note and resolveHub attaches it, but a note that no
 * caller emits is still a silent fallback with extra steps — which is what the first version
 * of this change was, caught by grepping for consumers and finding only the definition site.
 *
 * This drives the real MCP proxy against a credentials file whose "computer" entry is
 * unusable, and asserts the diagnostic reaches stderr. It deliberately tests the CALLER
 * rather than the resolver: the resolver was already covered, and the gap was that nothing
 * read it.
 *
 * Written by DeepSeek-D2V6 (reviewer).
 */

const PROXY = path.join(process.cwd(), "scripts", "opencadre-mcp.mjs");

const homeWith = (content: object) => {
  const home = mkdtempSync(path.join(tmpdir(), "oc-mcp-note-"));
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify(content));
  return home;
};

/** Runs the proxy and returns its stderr. stdin is closed immediately so it exits. */
async function proxyStderr(home: string): Promise<string> {
  return await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [PROXY, "--client", "claude-code"], {
      env: { ...process.env, OPENCADRE_HOOK_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    // Closing stdin lets the proxy finish its startup and exit deterministically rather than
    // waiting on a timeout - 30s for three tests became ~1s with this.
    child.stdin.end();
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(stderr));
  });
}

describe("the unusable-credential diagnostic reaches a real caller", () => {
  it("warns on stderr when a machine entry exists but is unusable", async () => {
    const home = homeWith({
      computer: { hub: "http://hub.example/", credential: "agt_wrong_prefix", deviceId: "d1" },
      devices: { "claude-code": { hub: "http://hub.example/", credential: `dev_${"cd".repeat(24)}`, deviceId: "old" } },
    });
    const stderr = await proxyStderr(home);
    expect(stderr).toMatch(/not usable/);
    expect(stderr).toMatch(/opencadre connect/);
    // The credential itself must never appear in a diagnostic.
    expect(stderr).not.toMatch(/dev_[0-9a-f]{48}/);
    expect(stderr).not.toMatch(/agt_/);
  }, 20_000);

  it("stays quiet when the machine entry is healthy", async () => {
    const home = homeWith({
      computer: { hub: "http://hub.example/", credential: `dev_${"ab".repeat(24)}`, deviceId: "d1" },
    });
    const stderr = await proxyStderr(home);
    expect(stderr).not.toMatch(/not usable/);
  }, 20_000);

  it("stays quiet for a plain legacy install - a legitimate state, not a fault", async () => {
    const home = homeWith({
      devices: { "claude-code": { hub: "http://hub.example/", credential: `dev_${"cd".repeat(24)}`, deviceId: "old" } },
    });
    const stderr = await proxyStderr(home);

    // ASSERT THE PROPERTY, NOT A LIST OF PHRASES.
    //
    // The resolver DOES return a non-null note for this shape, and the consumer suppresses it.
    // Asserting `not.toMatch(/not usable/)` - the original form - passes even when the
    // suppression is REMOVED, because the legacy note does not contain that phrase. That
    // mutant (widening the guard to `if (deviceResolution?.note)`) survived the entire
    // 1507-test suite, found by DeepSeek-NWPS.
    //
    // A list of phrases is only marginally better: NWPS then reworded the note AND re-widened
    // the guard, and a three-phrase assertion still passed 3/3. A phrase list covers what the
    // note says TODAY and nothing it might say TOMORROW - and you would be rewording precisely
    // because you wanted different words, so that is when the rail is needed and absent.
    //
    // The property that holds for ANY wording: a healthy start must produce no diagnostic
    // ABOUT THE CREDENTIAL. Note this cannot be `not.toMatch(/opencadre-mcp:/)` - asserting
    // stderr is entirely silent fails on legitimate, unrelated chatter (this proxy also
    // reports "no usable session id (absent)" in this fixture). NWPS proposed the stronger
    // form; measuring the actual output showed why it needs this qualification, and that is
    // worth more than the tidier assertion it replaces.
    const credentialDiagnostics = stderr
      .split("\n")
      .filter((line) => line.startsWith("opencadre-mcp:"))
      .filter((line) => /credential|computer|opencadre connect|per-tool/i.test(line));
    expect(
      credentialDiagnostics,
      `a healthy legacy install must not be told to fix its credential, but stderr said: ${credentialDiagnostics.join(" | ")}`,
    ).toEqual([]);
  }, 20_000);
});