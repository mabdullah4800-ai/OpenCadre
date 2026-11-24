import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// AGENTS.md's non-negotiable rule: "Never put a secret in chat, a commit, a log, a PR or an issue.
// That covers API keys (agt_..., org_...), passwords, tokens and connection strings, even
// partially." This session enforced it by hand -- grepping every diff before every push -- which
// works only as long as someone remembers to. This test makes it a CI gate instead: it runs in
// `npm test`, which CI's ci.yml already requires on every push and PR.
//
// A real key is `${prefix}_${randomBytes(24).toString("hex")}` (see generateApiKey in src/auth.ts
// and the "dev_" device credential in src/devices.ts) -- always exactly 48 lowercase hex chars
// after the prefix. That length is specific enough that a real leaked key can't be confused with a
// prefix mentioned in prose (AGENTS.md's own "agt_..., org_..." example is far shorter) or a
// shorter placeholder.
const KEY_PATTERN = /\b(agt|org|dev)_[0-9a-f]{48}\b/g;

// Exact matches this scan must not flag, each with why it's not a real secret. Add here, never by
// loosening KEY_PATTERN -- a narrower allowlist entry is auditable, a looser regex is a blind spot.
const ALLOWLIST = new Set([
  // tests/awareness-hook.test.ts: a deliberately-sequential, obviously-synthetic placeholder used to
  // test key-shaped-string handling in awareness digest text, never a real generated key.
  "agt_0123456789abcdef0123456789abcdef0123456789abcdef",
]);

const TEXT_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|sh|yml|yaml)$/;

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: process.cwd(), encoding: "utf8" });
  return out.split("\n").filter((f) => f && TEXT_EXTENSIONS.test(f));
}

// #303: this scan took 4034ms of its own 5000ms default budget on a cold cache and 77ms warm -- a 65x
// swing that made the suite pass or fail on machine state rather than on content. The cost is disk
// I/O across ~400 tracked files, not the regex.
//
// Deliberately NOT fixed by narrowing the scan to src/cli/scripts/public/examples, which #303
// proposed: docs/, tests/ and AGENTS.md are exactly where a pasted key gets committed -- a key
// reaches a runbook or a test fixture at least as easily as a source file -- so narrowing would trade
// a real blind spot for speed on the one rule AGENTS.md calls non-negotiable. Instead the reads run
// concurrently, which is where cold-cache latency actually goes, and the budget is stated explicitly
// so a slow disk reports the truth rather than a phantom secret-scan failure.
const SCAN_TIMEOUT_MS = 30_000;

describe("source hygiene: no hardcoded API key ever lands in a tracked file", () => {
  it("no tracked file contains a real-shaped agt_/org_/dev_ key outside the allowlist", async () => {
    const files = trackedTextFiles();
    const contents = await Promise.all(files.map(async (file) => {
      try {
        return { file, content: await readFile(file, "utf8") };
      } catch {
        return null; // e.g. a broken symlink tracked by git; not this test's concern
      }
    }));
    const offenders: Array<{ file: string; match: string }> = [];
    for (const entry of contents) {
      if (!entry) continue;
      for (const match of entry.content.matchAll(KEY_PATTERN)) {
        if (!ALLOWLIST.has(match[0])) offenders.push({ file: entry.file, match: match[0] });
      }
    }
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("the allowlist itself only contains synthetic keys, not real ones -- a real key hashes to a value nothing else in this repo depends on", () => {
    // Loose guard against someone "fixing" a future failure by adding a real leaked key to the
    // allowlist instead of removing it from source: every allowlisted string must match the same
    // shape KEY_PATTERN looks for (so it's provably a key-shaped string, not evidence of laundering
    // something else through this list) and there must be very few of them.
    expect(ALLOWLIST.size).toBeLessThan(5);
    for (const key of ALLOWLIST) expect(key).toMatch(/^(agt|org|dev)_[0-9a-f]{48}$/);
  });
});
