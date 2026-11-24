import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The check runs as a CHILD PROCESS, not an import: verify() is not exported and it calls
// process.exit, so the observable contract is its stdout and exit code, exactly as for the
// lock doctor. This file pins the defect a folder with no OpenCadre block is INVISIBLE to
// verify() even though it resolves to the machine-wide agent and therefore shares an identity.

const SCRIPT = fileURLToPath(new URL("../scripts/reasonix-agents.mjs", import.meta.url));

/** A Reasonix home whose machine-wide config names one agent: what every keyless folder inherits. */
function machineWideHome(key = "agt_machine_wide_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"): string {
  const home = mkdtempSync(path.join(tmpdir(), "rx-home-"));
  writeFileSync(
    path.join(home, "config.toml"),
    ['[[plugins]]', 'name    = "opencadre"', 'type    = "http"', 'url     = "https://app.opencadre.example/mcp"', `headers = { Authorization = "Bearer ${key}" }`, ""].join("\n"),
  );
  return home;
}

/** A root with one folder that owns NO reasonix.toml at all. */
function rootWithKeylessFolder(name = "keyless"): string {
  const root = mkdtempSync(path.join(tmpdir(), "rx-root-"));
  mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

function runVerify(root: string, home: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "verify", "--root", root], {
      env: { ...process.env, REASONIX_HOME: home, OPENCADRE_KEY: "", OPENCADRE_URL: "" },
      encoding: "utf8",
    });
    return { out, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; status?: number };
    return { out: e.stdout ?? "", code: e.status ?? 1 };
  }
}

describe("verify reports folders that inherit the machine-wide agent", () => {
  it("names a keyless folder as INHERITED rather than calling the tree clean", () => {
    const home = machineWideHome();
    const root = rootWithKeylessFolder("keyless");

    const { out, code } = runVerify(root, home);

    expect(out).toContain("INHERITED");
    expect(out).toContain("keyless");
    expect(code).toBe(1);
  });

  it("does not claim every folder is distinct while an inherited one is present", () => {
    // The defect precisely: discover() sees no folder here, so verify() used to fail with
    // "No folders with an opencadre block" and never mention that the folder resolves, shared.
    const { out } = runVerify(rootWithKeylessFolder("silent-sharer"), machineWideHome());

    expect(out).not.toContain("OK: every reachable folder is a distinct agent");
    expect(out).toContain("silent-sharer");
  });

  it("stays quiet when a folder owns its own block, so the check does not cry wolf", () => {
    const home = machineWideHome();
    const root = rootWithKeylessFolder("owner");
    writeFileSync(
      path.join(root, "owner", "reasonix.toml"),
      ['[[plugins]]', 'name    = "opencadre"', 'type    = "http"', 'url     = "https://app.opencadre.example/mcp"', 'headers = { Authorization = "Bearer agt_owner_key_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }', ""].join("\n"),
    );

    const { out } = runVerify(root, home);

    expect(out).toContain("owner");
    expect(out).not.toContain("owner, "); // not listed among the inherited
  });
});
