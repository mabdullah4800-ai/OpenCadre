import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_HTTP,
  CLAUDE_STDIO,
  CODEX_HTTP,
  CODEX_STDIO,
  REASONIX_CANONICAL,
  REASONIX_INLINE,
} from "./fixtures/client-configs";

// These tests use CAPTURED fixtures (tests/fixtures/client-configs.ts) rather than configs composed
// in the test body. See tests/fixtures/README.md for the rule and the two incidents behind it.
//
// SCOPE, deliberately explicit: this file pins the FIXTURE VALUES. It does NOT call the Reasonix
// reader — and the reason is NOT that the reader is missing. `reasonixPlugin` is on main in
// `scripts/opencadre-config.mjs` — added by a1c2fb2, exported for the hook by ec61422 — and
// `scripts/reasonix-opencadre-hook.mjs` imports it directly. An earlier version of this comment
// claimed the opposite, and that is worth recording as a defect rather than a typo: it sent a
// reader to `reasonix/fleet-identity`, a branch that never landed (`git merge-base --is-ancestor
// 083df2b5 main` returns 1; against `47dd458` it stood 10 ahead and 547 behind). That made a
// reachable function look unreachable, and a describer that understates reachability suppresses the
// test someone would otherwise write, so this is the direction in which wrong prose costs something.
//
// The scope stands on a reason that survives that history: these fixtures are the contract's VALUES,
// and the reader's behaviour is exercised through the hook. Pinning values here keeps the fixture set
// from regressing to a hand-composed single-form fixture whatever the reader's implementation does.
//
// The falsification below is therefore self-contained: it reproduces the pre-fix scan verbatim, so
// the discriminating power of these fixtures is executable here without a git checkout.

const KEY_PLACEHOLDER = "${OPENCADRE_KEY}";

/** A folder holding a config written exactly as given. */
function homeWith(config: string) {
  const home = mkdtempSync(path.join(tmpdir(), "rx-cap-"));
  writeFileSync(path.join(home, "config.toml"), config);
  return home;
}

describe("captured client fixtures — the values a real client writes", () => {
  it("Reasonix INLINE: the shape reasonix-agents.mjs writes into a folder", () => {
    expect(REASONIX_INLINE).toMatch(/^\[\[plugins\]\]$/m);
    expect(REASONIX_INLINE).toMatch(/^name\s+= "opencadre"$/m);
    expect(REASONIX_INLINE).toMatch(/^headers = \{ Authorization = "Bearer \$\{OPENCADRE_KEY\}" \}$/m);
    // The tell that separates it from the canonical form: no sub-table header at all.
    expect(REASONIX_INLINE).not.toMatch(/\[plugins\.headers\]/);
  });

  it("Reasonix CANONICAL: the sub-table Reasonix rewrites its own config into", () => {
    expect(REASONIX_CANONICAL).toMatch(/^\[plugins\.headers\]$/m);
    expect(REASONIX_CANONICAL).toMatch(/^\s+Authorization = "Bearer \$\{OPENCADRE_KEY\}"$/m);
    // The tell that separates it from the inline form: no inline `headers = { … }` line.
    expect(REASONIX_CANONICAL).not.toMatch(/^headers = \{/m);
  });

  it("the two Reasonix forms are genuinely different — a one-form fixture tests half the contract", () => {
    expect(REASONIX_INLINE).not.toBe(REASONIX_CANONICAL);
    expect(REASONIX_INLINE.replace(/\s+/g, " ")).not.toBe(REASONIX_CANONICAL.replace(/\s+/g, " "));
  });

  it("the captured Codex live entry carries NO URL, Bearer or http_headers", () => {
    // Guards the divergence this capture surfaced: both live clients hold a keyless stdio proxy,
    // while the hand-composed fixtures asserted an HTTP+Bearer entry.
    expect(CODEX_STDIO).not.toMatch(/http_headers/);
    expect(CODEX_STDIO).not.toMatch(/Bearer/);
    expect(CODEX_STDIO).toMatch(/mcp_servers\.opencadre-session/);
    expect(CODEX_STDIO).toMatch(/"--client", "codex"/);
  });

  it("the captured Claude Code live entry is stdio with an empty env and no Bearer", () => {
    const entry = CLAUDE_STDIO.mcpServers["opencadre-session"] as Record<string, unknown>;
    expect(entry.type).toBe("stdio");
    expect(entry.env).toEqual({});
    expect(JSON.stringify(entry)).not.toMatch(/Bearer/);
    expect(JSON.stringify(entry)).toMatch(/opencadre-mcp\.mjs/);
  });

  it("keeps the HTTP+Bearer writer shapes available as the second supported form", () => {
    // Both paths are shipped: the connect writer still emits these, so neither may be dropped.
    expect(CODEX_HTTP).toMatch(/http_headers = \{ "Authorization" = "Bearer /);
    expect(CLAUDE_HTTP.mcpServers.opencadre.type).toBe("http");
    expect(CLAUDE_HTTP.mcpServers.opencadre.headers.Authorization).toMatch(/^Bearer /);
  });

  it("a captured fixture round-trips through disk unchanged", () => {
    const home = homeWith(REASONIX_CANONICAL);
    expect(readFileSync(path.join(home, "config.toml"), "utf8")).toBe(REASONIX_CANONICAL);
  });

  it("no fixture contains a live key — only the placeholder", () => {
    for (const text of [REASONIX_INLINE, REASONIX_CANONICAL, CODEX_STDIO, CODEX_HTTP]) {
      expect(text).not.toMatch(/agt_[A-Za-z0-9]{20,}/);
    }
    expect(REASONIX_INLINE).toContain(KEY_PLACEHOLDER);
  });
});

describe("falsification — the pre-fix scan must fail on the captured canonical form", () => {
  // The pre-fix block scan, reproduced verbatim from the revision that shipped it: it ends a
  // [[plugins]] block at ANY line starting with `[` — which is the `[plugins.headers]` header
  // itself. It stops one line short of the Authorization line, so the Bearer lookup finds nothing.
  const preFixScan = (text: string, expand: (n: string) => string | undefined) => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*\[\[plugins\]\]\s*$/.test(lines[i])) continue;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]); j += 1) body.push(lines[j]);
      const block = body.join("\n");
      if (!/name\s*=\s*"opencadre"/.test(block)) continue;
      const url = block.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1];
      const raw = block.match(/Bearer\s+([^"'\s]+)/)?.[1];
      if (!url || !raw) return null;
      const expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => expand(name) ?? whole);
      if (/\$\{/.test(expanded)) return null;
      return { hub: url.replace(/\/mcp$/, ""), key: expanded };
    }
    return null;
  };

  /** The fixed scan: a `[plugins.…]` sub-table belongs to THIS plugin; anything else ends it. */
  const fixedScan = (text: string, expand: (n: string) => string | undefined) => {
    const startsNewTable = (line: string) => /^\[/.test(line) && !/^\[plugins\./.test(line);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*\[\[plugins\]\]\s*$/.test(lines[i])) continue;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !startsNewTable(lines[j]); j += 1) body.push(lines[j]);
      const block = body.join("\n");
      if (!/name\s*=\s*"opencadre"/.test(block)) continue;
      const url = block.match(/^\s*url\s*=\s*["']([^"']+)["']/m)?.[1];
      const raw = block.match(/Bearer\s+([^"'\s]+)/)?.[1];
      if (!url || !raw) return null;
      const expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => expand(name) ?? whole);
      if (/\$\{/.test(expanded)) return null;
      return { hub: url.replace(/\/mcp$/, ""), key: expanded };
    }
    return null;
  };

  const KEY = "agt_" + "A".repeat(48);
  const expandWith = (v: string) => (n: string) => (n === "OPENCADRE_KEY" ? v : undefined);

  it("pre-fix returns NOTHING for the captured canonical form — the shipped defect", () => {
    expect(preFixScan(REASONIX_CANONICAL, expandWith(KEY))).toBeNull();
  });

  it("pre-fix DOES resolve the inline form — which is why one fixture hid the bug", () => {
    // Incident 2 in one assertion: the form the test authored worked, so the suite stayed green
    // while production's other form resolved to nothing.
    expect(preFixScan(REASONIX_INLINE, expandWith(KEY))?.key).toBe(KEY);
  });

  it("the fixed scan resolves BOTH captured forms — the fix, stated as a difference", () => {
    expect(fixedScan(REASONIX_CANONICAL, expandWith(KEY))?.key).toBe(KEY);
    expect(fixedScan(REASONIX_INLINE, expandWith(KEY))?.key).toBe(KEY);
  });

  it("the fixed scan reads a LITERAL key from the sub-table, with no ${VAR} expansion", () => {
    // Removes the expansion path, so a scan that only appears to work because the environment
    // supplied the key cannot pass.
    const literal = "agt_" + "B".repeat(48);
    const text = REASONIX_CANONICAL.replace(KEY_PLACEHOLDER, literal);
    expect(fixedScan(text, () => undefined)?.key).toBe(literal);
  });

  it("the fixed scan still refuses an unresolved ${VAR} rather than returning a bad key", () => {
    expect(fixedScan(REASONIX_CANONICAL, () => undefined)).toBeNull();
  });
});