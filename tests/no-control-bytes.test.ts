import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A literal NUL byte in a source file makes git treat it as binary, so reviewers
// see "Bin 0 -> N bytes" instead of a diff (it happened in src/escalation.ts).
// Use escapes like the \u0000 escape in code, never the raw byte.
const ROOTS = ["src", "scripts", "examples", "public", "tests"];
const TEXT = /\.(ts|mjs|js|cjs|json|md|html|css|sh)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : TEXT.test(name) ? [path] : [];
  });
}

describe("source hygiene", () => {
  it("no source file contains a raw NUL byte", () => {
    const offenders = ROOTS.flatMap(files).filter((f) => readFileSync(f).includes(0));
    expect(offenders).toEqual([]);
  });
});
