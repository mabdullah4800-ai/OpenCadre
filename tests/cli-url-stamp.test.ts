import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliTarballUrl, connectCommand } from "../src/connect.js";

// Found live: npx caches a tarball by its URL, so a machine that ran the connect command before kept running the old CLI
// after a deploy ("--code must look like oc_..." for a new ocd_ code). The URL carries a stamp of the package itself, as a
// PATH segment (Q1g): <hub>/cli/<stamp>/opencadre-cli.tgz, the immutable alias, so no query-stripping tool can turn it back
// into the bare URL npx has cached. The ?v= form this used to print still works on the bare route (tests/cli-manifest.test.ts).
describe("CLI package URL stamp", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-cli-stamp-"));
  const file = path.join(dir, "opencadre-cli.tgz");
  afterEach(() => {
    delete process.env.OPENCADRE_CLI_TARBALL;
  });

  it("stamps the URL with a hash of the package, and the stamp changes only when the package does", () => {
    process.env.OPENCADRE_CLI_TARBALL = file;
    writeFileSync(file, "cli version one");
    const first = cliTarballUrl("https://hub.example.test");
    expect(first).toMatch(/^https:\/\/hub\.example\.test\/cli\/[0-9a-f]{12}\/opencadre-cli\.tgz$/);
    expect(cliTarballUrl("https://hub.example.test")).toBe(first);

    writeFileSync(file, "cli version two, a different build");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const second = cliTarballUrl("https://hub.example.test");
    expect(second).not.toBe(first);
    expect(connectCommand("https://hub.example.test", "oc_ABCDEFGHJK", "codex"))
      .toBe(`npx -y ${second} connect --hub https://hub.example.test --code oc_ABCDEFGHJK --client codex`);
  });

  it("leaves the URL unstamped when no package is built", () => {
    process.env.OPENCADRE_CLI_TARBALL = path.join(dir, "missing.tgz");
    expect(cliTarballUrl("https://hub.example.test")).toBe("https://hub.example.test/cli/opencadre-cli.tgz");
    rmSync(dir, { recursive: true, force: true });
  });
});
