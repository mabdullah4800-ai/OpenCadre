// §9 item 7 — one resolver for CODEX_HOME, used by EVERY writer.
//
// THE DEFECT THIS CLOSES. `CODEX_HOME` relocates the whole Codex state tree (vendor env-vars page,
// fetched 2026-09-20: *"Sets the root for Codex state, including config, auth, logs, sessions, skills,
// and standalone package metadata. If you set it, the directory must already exist."*). OpenCadre
// hardcoded `join(home, ".codex", …)` in eight places, so a user with a relocated install got a config
// written where **Codex never looks** — and `connect` reported success.
//
// WHY THE TESTS DRIVE THE WRITERS AND NOT THE RESOLVER. This is the whole point of the file. A test
// that sets `CODEX_HOME` and asserts `codexHome()` returns it proves the RESOLVER works and learns
// nothing about the feature: a resolver four callers use and a fifth bypasses passes that test while
// the fifth writes to the wrong place. So every case below calls a WRITER — the same function `connect`,
// `doctor` and the usage reporter call — and asserts where it lands. The assertion is on the PATH the
// writer produces, which is the observable that differs between "routed" and "bypassed".
//
// The one case that is allowed to touch the resolver directly is the semantics table at the top, and
// only because a comment claiming a direction is not evidence for it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "oc-codexhome-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** A relocated root that EXISTS, because the vendor requires it to and a resolver that pointed at a
 * missing directory would make every writer fail for a different reason than the one under test. */
const relocated = () => {
  const root = mkdtempSync(path.join(dir, "codex-home-"));
  return { root, env: { CODEX_HOME: root } };
};

describe("CODEX_HOME semantics — the direction, stated as assertions", () => {
  it("is the state ROOT, not a parent: the override REPLACES ~/.codex", async () => {
    const { codexHome } = await import("../cli/lib/clients.mjs");
    const { root, env } = relocated();
    // The vendor's own measurement on the fleet PC agrees: the desktop app sets
    // CODEX_HOME = 'C:\Users\dev\.codex' — the .codex directory itself.
    expect(codexHome("/home/u", env)).toBe(root);
    // Getting this backwards is the defect this item exists to prevent, so it is asserted rather than
    // left to the comment: a parent-shaped reading would produce <root>/.codex.
    expect(codexHome("/home/u", env)).not.toBe(path.join(root, ".codex"));
  });

  it("falls back to ~/.codex when the variable is ABSENT", async () => {
    const { codexHome } = await import("../cli/lib/clients.mjs");
    expect(codexHome("/home/u", {})).toBe(path.join("/home/u", ".codex"));
  });

  it("treats a BLANK value as absent, not as a root of ''", async () => {
    // `CODEX_HOME=""` is set-but-useless. Resolving it as a path would point every Codex file at the
    // CWD or at nothing, which is worse than the default it replaced.
    const { codexHome } = await import("../cli/lib/clients.mjs");
    expect(codexHome("/home/u", { CODEX_HOME: "" })).toBe(path.join("/home/u", ".codex"));
    expect(codexHome("/home/u", { CODEX_HOME: "   " })).toBe(path.join("/home/u", ".codex"));
  });
});

describe("every WRITER lands under CODEX_HOME — not just the resolver", () => {
  // Each case names the module that owns the write, because "one resolver" is only true if the callers
  // use it. A bypass in any one of these is invisible to the others.

  it("1. clientConfigFile — the config `connect` WRITES", async () => {
    const { clientConfigFile } = await import("../cli/lib/clients.mjs");
    const { root, env } = relocated();
    expect(clientConfigFile("/home/u", "codex", env)).toBe(path.join(root, "config.toml"));
  });

  it("2. detectClients — Codex is FOUND at a relocated root", async () => {
    // The mirror of the write: a detection that only looked at ~/.codex would report a working install
    // as absent, so `connect` would never set it up and nothing would look broken.
    //
    // `detectClients` returns a LIST of names, not a map — asserted that way rather than assumed, since
    // a `.codex` property on an array is silently `undefined` and would read as "not detected".
    const { detectClients } = await import("../cli/lib/clients.mjs");
    const { root, env } = relocated();
    expect(detectClients("/home/u", env)).toContain("codex");
    // And the negative: with no CODEX_HOME and no ~/.codex, it is genuinely absent — so the case above
    // is not passing because the predicate always returns true.
    expect(detectClients(path.join(dir, "empty-home"), {})).not.toContain("codex");
  });

  it("3. sessionHooksFile — hooks.json, the file whose hash Codex gates", async () => {
    const { sessionHooksFile } = await import("../cli/lib/session-hooks.mjs");
    const { root, env } = relocated();
    expect(sessionHooksFile("/home/u", "codex", env)).toBe(path.join(root, "hooks.json"));
    // claude-code is unaffected: CODEX_HOME relocates Codex's tree only.
    expect(sessionHooksFile("/home/u", "claude-code", env)).toBe(path.join("/home/u", ".claude", "settings.json"));
  });

  it("4. inboxSkillFile — the Codex-only inbox skill", async () => {
    const { inboxSkillFile } = await import("../cli/lib/codex-app.mjs");
    const { root, env } = relocated();
    expect(inboxSkillFile("/home/u", env)).toBe(path.join(root, "skills", "opencadre-inbox", "SKILL.md"));
  });

  it("5. planCodexSessionServer — the DEVICE path's writer, and the one a connect hits first", async () => {
    const { planCodexSessionServer } = await import("../cli/lib/device.mjs");
    const { root, env } = relocated();
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      // This one takes no env parameter — it is called from `connect`, which reads process.env.
      expect(planCodexSessionServer({ home: "/home/u", proxyPath: "/bin/opencadre-mcp.mjs" }).file)
        .toBe(path.join(root, "config.toml"));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it("6. the config READER used by hooks and the proxy", async () => {
    // scripts/opencadre-config.mjs's codex() is what every hook goes through to find the hub and key.
    // A writer that relocated while this reader did not would leave an install that writes where Codex
    // looks and then cannot read it back.
    const { resolveNamedAgent } = await import("../scripts/opencadre-config.mjs");
    const { root } = relocated();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "config.toml"),
      `[mcp_servers.opencadre]\nurl = "https://relocated.example/mcp"\nhttp_headers = { "Authorization" = "Bearer agt_${"a".repeat(48)}" }\n`);
    // Driven through process.env rather than an injected `env`, because that is how the reader is
    // wired: `resolveNamedAgent` takes an `env`, but it passes only `(dir, cwd)` down to the per-client
    // READER, so the reader's own `codexHome` sees process.env. Measured, not assumed — an injected
    // `{ CODEX_HOME }` here resolves to nothing, which is a testability gap and NOT a production one
    // (production sets the real environment). Worth one line of note for whoever threads it later.
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const found = resolveNamedAgent({ client: "codex", cwd: root, home: "/home/u" });
      expect(found.base).toBe("https://relocated.example");
      expect(found.source).toBe("codex");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it("7. the usage reporter's rollout reader", async () => {
    // The exported surface of scripts/opencadre-usage.mjs is the CLI, so this drives the resolver the
    // module itself calls rather than reaching into a private function: assert the PATH the module
    // builds for its sessions root. A test that only checked the resolver would not notice this file
    // being missed, which is the failure mode the brief names.
    const src = await import("node:fs").then((fs) => fs.readFileSync(path.join(process.cwd(), "scripts", "opencadre-usage.mjs"), "utf8"));
    // No `join(home, ".codex"` may survive in the file: the literal is the bypass signature.
    expect(src).not.toMatch(/join\(home,\s*"\.codex"/);
    expect(src).toMatch(/codexHome\(home\)/);
  });

  it("8. doctor's trust-state reader", async () => {
    // Read through runDoctor's own path: a trust table under the relocated root must be found, because
    // missing it reports "no trust recorded" for an install that has recorded it.
    const { runDoctor } = await import("../cli/lib/doctor.mjs");
    const { root } = relocated();
    const home = mkdtempSync(path.join(dir, "doctor-home-"));
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "config.toml"),
      // The key is a VALID TOML basic string (JSON.stringify escapes a Windows root's backslashes): since #692 doctor decodes
      // keys, and an unescaped `"C:\…"` is not TOML at all (Codex could not have written or read it).
      `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n[hooks.state.${JSON.stringify(`local:${root}/hooks.json:stop:0:0`)}]\ntrusted_hash = "sha256:abc"\n`);
    writeFileSync(path.join(root, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "C:\\bin\\opencadre-awareness.mjs" --client codex`, timeout: 10 }] }] } }));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const r = await runDoctor({ client: "codex", home });
      // The trust line is only reachable if the config at the RELOCATED root was read.
      expect(r.lines.join("\n")).toMatch(/has recorded hook trust for this hooks\.json/);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  }, 30_000);
});

describe("no writer still bypasses the resolver", () => {
  it("the .codex literal appears in exactly ONE executable place across the shipped tree", () => {
    // The structural half of "one resolver". A per-call-site test proves each caller is right TODAY;
    // this proves there is no NINTH caller that nobody wrote a test for — which is precisely how the
    // eight came to exist. Comments and the resolver's own default are the only permitted matches.
    const fs = require("node:fs") as typeof import("node:fs");
    const roots = ["cli", "scripts"];
    const offenders: string[] = [];
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dev") walk(full); continue; }
        if (!/\.(mjs|ts)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (!/"\.codex"/.test(line)) continue;
          const trimmed = line.trim();
          // Comments explain the literal and a doc line may quote it; neither is a caller.
          if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
          // The resolver's own default, and the one entry that legitimately spells the fallback.
          if (full.endsWith(path.join("scripts", "opencadre-clients.mjs"))) continue;
          // A dev-only tool that reads Codex's OWN log database is not an OpenCadre writer: it follows
          // whatever Codex wrote rather than deciding where to write. Named here rather than silently
          // excluded, so the bypass decision is visible to the next reader.
          if (full.endsWith(path.join("scripts", "codex-log-query.mjs"))) continue;
          offenders.push(`${full}:${i + 1}  ${trimmed}`);
        }
      }
    };
    for (const r of roots) walk(path.join(process.cwd(), r));
    expect(offenders).toEqual([]);
  });
});
