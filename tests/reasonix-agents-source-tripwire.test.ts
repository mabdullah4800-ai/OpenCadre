// A tripwire against the home rule being re-declared inside reasonix-agents.mjs.
//
// WHY SOURCE-LEVEL. That file's own copy of the rule is gone and it now imports reasonixHome() from
// the hook, but nothing fails if the copy comes back: every fixture in
// tests/reasonix-inherited-identity.test.ts sets REASONIX_HOME, which is the ONE branch where any two
// copies of the rule agree by construction. The divergence the unification fixed is on the FALLBACK,
// and on this host the fallback is identical in both implementations (%APPDATA%\Reasonix) - so no
// fixture, with or without REASONIX_HOME, can tell a copy from the import here. The real divergence
// is POSIX-only and this suite cannot assume its platform. What is assertable everywhere is the
// shape of the source: the module imports the rule, and carries no copy of it.
//
// Same idiom as tests/console-dark-mode-stage2.test.ts ("components reference the tokens, not a
// hardcoded literal"), and for the same reason: the property is which implementation is used, and
// values alone cannot show that.
//
// Not hypothetical: #395's own first commit minted a copy (53fd828) and a later one deleted it
// (4517759) - so the return this guards against has already happened once.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../scripts/reasonix-agents.mjs", import.meta.url)), "utf8");

describe("reasonix-agents.mjs uses the shared home rule", () => {
  it("reads the file it claims to read", () => {
    // The positive control for the assertions below. `not.toContain` on an empty string PASSES, so a
    // broken path or an unreadable file would leave this file green while checking nothing at all.
    expect(SRC.length).toBeGreaterThan(0);
    expect(SRC).toContain("inheritedFolders");
  });

  it("imports reasonixHome from the hook rather than deriving a home itself", () => {
    expect(SRC).toMatch(/import \{[^}]*\breasonixHome\b[^}]*\} from "\.\/reasonix-opencadre-hook\.mjs"/);
  });

  it("carries no REASONIX_HOME of its own", () => {
    // The variable name is the tell. The branch belongs to reasonixRoots(), and a second reader of it
    // here is how the two homes diverged the first time.
    expect(SRC).not.toContain("REASONIX_HOME");
  });
});
