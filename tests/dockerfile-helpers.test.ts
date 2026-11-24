// The image's build stage runs `npm run build`, which packs every fleet helper (cli/lib/helpers.mjs HELPERS) into the
// CLI tarball the hub serves. A helper whose source the build stage never COPYs breaks that build, and with it every
// deploy: measured 2026-09-28, main 562d0b1e failed `docker build` with "pack-cli: ENOENT ... examples/opencode-plugin/
// clearance.js" because the Dockerfile copied examples/hooks only. This reads the Dockerfile as data, so a new helper
// directory fails here instead of on the deploy box.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELPERS } from "../cli/lib/helpers.mjs";

/** The destination-relative sources the FIRST stage (the one that runs `npm run build`) copies from the context. */
function buildStageCopies(dockerfile: string): string[] {
  const lines = dockerfile.split(/\r?\n/);
  const stages = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter((i) => i >= 0);
  const build = lines.slice(stages[0], stages[1] ?? lines.length);
  return build
    .filter((l) => /^COPY\s/i.test(l) && !/--from=/i.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1))
    .map((src) => src.replace(/^\.\//, "").replace(/\/$/, ""));
}

const covered = (copies: string[], file: string) =>
  copies.some((src) => src === "." || file === src || file.startsWith(`${src}/`));

describe("Dockerfile build stage", () => {
  const copies = buildStageCopies(readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8"));

  it("copies the source of every helper the CLI pack includes", () => {
    const missing = Object.values(HELPERS as Record<string, string>).filter((file) => !covered(copies, file));
    expect(missing).toEqual([]);
  });

  it("would catch a helper directory the build stage does not copy", () => {
    // The check itself: drop the opencode-plugin COPY and the same helpers must be reported missing.
    const without = copies.filter((src) => src !== "examples/opencode-plugin");
    const missing = Object.values(HELPERS as Record<string, string>).filter((file) => !covered(without, file));
    expect(missing).toContain("examples/opencode-plugin/clearance.js");
  });

  it("copies cli-provenance.json into the build stage, optionally, at the root pack-cli reads it from", () => {
    // Q1g: the deploy archive carries the helpers' git history as cli-provenance.json (scripts/deploy-archive.sh) because
    // this stage has no .git. Not copied means every production build.json falls back to provenance "none" in silence.
    // The source must be a wildcard (`cli-provenance.json*`) so a build from a plain checkout, which has no such file,
    // still builds; its COPY destination is the WORKDIR root, where scripts/cli-build-info.mjs looks.
    const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8").split(/\r?\n/);
    const line = dockerfile.find((l) => /^COPY\s/i.test(l) && /\scli-provenance\.json\*\s/.test(l));
    expect(line, "a build-stage COPY of cli-provenance.json*").toBeDefined();
    expect(line!.trim().split(/\s+/).at(-1)).toBe("./");
    expect(copies).toContain("cli-provenance.json*");
  });
});
