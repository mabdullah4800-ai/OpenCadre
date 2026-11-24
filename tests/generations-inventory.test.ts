// 049a §2b-3: "inventory every cross-entry import and spawn, and every absolute install-root import". The inventory
// is cli/lib/generations.mjs LEGACY_EDGES; this file rebuilds it from the helpers' own text, so a new edge cannot be
// added without the table (and its justification) changing too. It also derives the ENTRY set from what the
// client-config writers reference, and checks that the helpers which locate themselves use the install ROOT.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ENTRIES, HELPERS, installedText } from "../cli/lib/helpers.mjs";
import { absoluteInstallRootRefs, resolveImports, spawnTargets } from "../cli/lib/imports.mjs";
import { LEGACY_EDGES } from "../cli/lib/generations.mjs";
import { installRoot } from "../scripts/opencadre-config.mjs";

const names = Object.keys(HELPERS).sort();
const entries = new Set(Object.keys(ENTRIES));

describe("the cross-entry inventory (LEGACY_EDGES) is what the helpers really do", () => {
  it("imports of another ENTRY", () => {
    const found = Object.fromEntries(names.map((n) => [n, resolveImports(n, installedText(n)).filter((d) => d !== n && entries.has(d))]).filter(([, d]) => d.length));
    expect(found).toEqual(LEGACY_EDGES.imports);
  });

  it("processes started by path relative to the helper's own file", () => {
    const found = Object.fromEntries(names.map((n) => [n, spawnTargets(n, installedText(n))]).filter(([, d]) => d.length));
    expect(found).toEqual(LEGACY_EDGES.spawns);
    // Every spawned file is an entry (so it has a stub, and a generation copy beside its caller).
    for (const targets of Object.values(found)) for (const t of targets) expect(entries.has(t), t).toBe(true);
  });

  it("paths built into the install root rather than beside the file", () => {
    expect(names.filter((n) => absoluteInstallRootRefs(installedText(n)))).toEqual(LEGACY_EDGES.absolute);
  });

  it("the scanners can see what they claim to (known positives)", () => {
    expect(spawnTargets("opencadre-awareness.mjs", `const W = fileURLToPath(new URL("./opencadre-wake.mjs", import.meta.url));`)).toEqual(["opencadre-wake.mjs"]);
    expect(spawnTargets("opencadre-cline-hook.mjs", `run("opencadre-approval-gate.mjs", 1); here("opencadre-awareness.mjs")`)).toEqual(["opencadre-approval-gate.mjs", "opencadre-awareness.mjs"]);
    expect(absoluteInstallRootRefs(`join(homedir(), ".opencadre", "bin", "x.mjs")`)).toBe(true);
    expect(absoluteInstallRootRefs(`join(homedir(), ".opencadre", "run")`)).toBe(false);
  });
});

describe("ENTRIES is exactly what the client-config writers reference", () => {
  it("derived from cli/bin/opencadre.mjs and the plan* writers, comments excluded", () => {
    const writers = ["cli/bin/opencadre.mjs", "cli/lib/session-hooks.mjs", "cli/lib/antigravity-hooks.mjs", "cli/lib/antigravity-rules.mjs", "cli/lib/device.mjs"];
    const referenced = new Set<string>();
    for (const file of writers) {
      const code = readFileSync(path.join(process.cwd(), file), "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      for (const m of code.matchAll(/["'`](opencadre-[a-z-]+\.m?js)/g)) referenced.add(m[1]);
      if (/["']opencode-plugin["']/.test(code)) referenced.add("opencode-plugin/index.js");
    }
    expect([...referenced].sort()).toEqual(Object.keys(ENTRIES).sort());
  });
});

describe("installRoot(): where a helper running inside a generation finds the install root", () => {
  const sep = path.sep;
  const root = path.resolve(sep, "home", "u", ".opencadre", "bin");
  it("strips .gen/<id>/ (and a plugin subfolder) but leaves any other folder as it is", () => {
    expect(installRoot(path.join(root, ".gen", "0123456789ab", "opencadre-session-stamp.mjs"))).toBe(root);
    expect(installRoot(path.join(root, ".gen", "0123456789ab", "opencode-plugin", "index.js"))).toBe(root);
    expect(installRoot(path.join(root, "opencadre-session-stamp.mjs"))).toBe(root);
    // Not a generation id: a folder that only looks like one is not stripped.
    expect(installRoot(path.join(root, ".gen", "not-an-id", "x.mjs"))).toBe(path.join(root, ".gen", "not-an-id"));
  });

  it("the session stamp compares the proxy's folder with the install root, not its own generation folder", () => {
    const text = readFileSync(path.join(process.cwd(), "examples", "hooks", "opencadre-session-stamp.mjs"), "utf8");
    expect(text).not.toMatch(/dirname\(fileURLToPath\(import\.meta\.url\)\)/);
    expect(text.match(/installRoot\(import\.meta\.url\)/g)).toHaveLength(2);
  });
});
