// The Reasonix-home rule: ONE implementation, and the order it resolves in.
//
// Two copies of this rule shipped and disagreed: the reader (opencadre-config.mjs) walked
// ~/.config/reasonix BEFORE ~/.reasonix, while the hook (reasonix-opencadre-hook.mjs) took the first
// EXISTING of ~/.reasonix then ~/.config/reasonix - the legacy order first, the opposite. Nothing
// compared them, so on a box holding BOTH directories the hook briefed from one home while the
// reader resolved the other, and the check in reasonix-agents.mjs that exists to catch exactly that
// agreed with whichever of the two it happened to share.
//
// Every assertion below is reachable on EITHER host. That is what `platform` is a parameter for:
// the alternative shape is an arm guarded by it.skipIf(process.platform !== "win32"), which the
// fleet's Linux verifier never runs - and an arm nobody runs is not evidence about the other one.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { reasonixCandidates, reasonixRoots, resolveHub } from "../scripts/opencadre-config.mjs";
import { reasonixHome } from "../scripts/reasonix-opencadre-hook.mjs";

const noEnv: NodeJS.ProcessEnv = { OPENCADRE_URL: "", OPENCADRE_KEY: "" };
const made: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = (key: string) =>
  [
    "[[plugins]]",
    '  name = "opencadre"',
    '  type = "http"',
    '  url = "https://app.opencadre.example/mcp"',
    "  [plugins.headers]",
    `    Authorization = "Bearer ${key}"`,
    "",
  ].join("\n");

const mkHome = (dir: string, key?: string) => {
  mkdirSync(dir, { recursive: true });
  if (key) writeFileSync(path.join(dir, "config.toml"), CONFIG(key));
};

describe("the order of the Reasonix home rule", () => {
  it("walks XDG first on POSIX and the APPDATA home alone on Windows", () => {
    const home = tempDir("rx-rule-");
    // Both are reachable from this host because the platform is an argument, not a branch taken at
    // import time against process.platform.
    expect(reasonixRoots(home, {}, "linux")).toEqual([
      path.join(home, ".config", "reasonix"),
      path.join(home, ".reasonix"),
    ]);
    expect(reasonixRoots(home, { APPDATA: path.join(home, "roaming") }, "win32")).toEqual([
      path.join(home, "roaming", "Reasonix"),
    ]);
  });

  it("falls to AppData/Roaming inside the user's home when APPDATA is unset", () => {
    // The `||`, not `&&`: with APPDATA absent the Windows arm must still produce a WINDOWS path.
    // The bug this pins had the guard go false instead, dropping the session into the POSIX list.
    const home = tempDir("rx-rule-");
    expect(reasonixRoots(home, {}, "win32")).toEqual([path.join(home, "AppData", "Roaming", "Reasonix")]);
  });

  it("REASONIX_HOME replaces the whole list, on both platforms", () => {
    const home = tempDir("rx-rule-");
    const override = path.join(home, "custom-reasonix");
    for (const platform of ["linux", "win32"]) {
      const env = { REASONIX_HOME: override };
      expect(reasonixRoots(home, env, platform)).toEqual([override]);
      // Even when it does not exist: an explicit override is not probed for, it is honoured.
      expect(reasonixHome(home, env, platform)).toBe(override);
    }
  });
});

describe("the resolved home, derived from that one order", () => {
  it("picks the canonical home when BOTH directories exist, and the legacy one when only it does", () => {
    // The paired control. Same tree, one variable: removing the XDG directory has to move the
    // answer, or the first assertion is not evidence that the order decided it.
    const home = tempDir("rx-rule-");
    const xdg = path.join(home, ".config", "reasonix");
    const legacy = path.join(home, ".reasonix");
    mkdirSync(xdg, { recursive: true });
    mkdirSync(legacy, { recursive: true });

    expect(reasonixHome(home, {}, "linux")).toBe(xdg);
    // And the point of sharing the rule: the resolved home IS the first entry of the list the
    // reader walks, so the two cannot report different homes.
    expect(reasonixHome(home, {}, "linux")).toBe(reasonixRoots(home, {}, "linux")[0]);

    rmSync(xdg, { recursive: true, force: true });
    expect(reasonixHome(home, {}, "linux")).toBe(legacy);
  });

  it("still resolves a legacy-only install, rather than pointing at a directory that is not there", () => {
    // Why the derived home probes for existence instead of taking the list's first entry blindly:
    // on a POSIX box with only ~/.reasonix, a bare roots[0] names ~/.config/reasonix and the
    // machine-wide briefing then silently finds no config at all.
    const home = tempDir("rx-rule-");
    const legacy = path.join(home, ".reasonix");
    mkdirSync(legacy, { recursive: true });
    expect(reasonixHome(home, {}, "linux")).toBe(legacy);
  });

  it("returns the canonical path when neither exists, which no caller can tell apart", () => {
    // Named so the difference is not mistaken for a behaviour nobody measured: every consumer either
    // reads <home>/config.toml or compares a path against it, and neither directory existing means
    // both reads miss and no folder is reported inherited. The path itself is only ever printed.
    const home = tempDir("rx-rule-");
    const roots = reasonixRoots(home, {}, "linux");
    expect(reasonixHome(home, {}, "linux")).toBe(roots[0]);
    expect(reasonixHome(home, {}, "linux")).toBe(path.join(home, ".config", "reasonix"));
  });

  it("never reaches a POSIX home on Windows, even with a legacy ~/.reasonix sitting there", () => {
    // The decoy has to EXIST for this to say which home won: with nothing at ~/.reasonix, falling
    // into the POSIX list would resolve to a path that does not exist and the assertion below would
    // pass for the wrong reason.
    const home = tempDir("rx-rule-");
    const appdata = path.join(home, "roaming");
    mkdirSync(path.join(home, ".reasonix"), { recursive: true });
    expect(reasonixHome(home, { APPDATA: appdata }, "win32")).toBe(path.join(appdata, "Reasonix"));
    // APPDATA unset is the arm the old `win32 && env.APPDATA` guard dropped through.
    expect(reasonixHome(home, {}, "win32")).toBe(path.join(home, "AppData", "Roaming", "Reasonix"));
  });
});

describe("each config expands ${VAR} from its OWN directory", () => {
  const VAR = "RX_HOME_RULE_OWNER";

  it("gives the two machine-wide roots the values of their own .env, not one shared file", () => {
    // The defect: one `reasonixEnv(roots[0])` was bound for every candidate, so a config that won
    // from ~/.reasonix read its variables out of ~/.config/reasonix/.env - a different install's
    // file. The two .env values differ, so an implementation that bound one expand for all of them
    // cannot return both of these.
    expect(process.env[VAR]).toBeUndefined(); // process env wins over any .env; it must not be set
    const home = tempDir("rx-rule-");
    const cwd = tempDir("rx-rule-cwd-");
    const xdg = path.join(home, ".config", "reasonix");
    const legacy = path.join(home, ".reasonix");
    mkdirSync(xdg, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(xdg, ".env"), `${VAR}=from-xdg\n`);
    writeFileSync(path.join(legacy, ".env"), `${VAR}=from-legacy\n`);

    const byFile = new Map(reasonixCandidates(home, cwd, noEnv, "linux"));
    expect(byFile.get(path.join(xdg, "config.toml"))?.(VAR)).toBe("from-xdg");
    expect(byFile.get(path.join(legacy, "config.toml"))?.(VAR)).toBe("from-legacy");
  });

  it("does not let a project-local reasonix.toml reach the machine-wide .env", () => {
    // The same binding, seen from the other side. A project file used to expand from roots[0]/.env,
    // so a repository could pull a value out of the machine's own secrets file and put it in a url.
    // It now expands from the process environment and its own directory only.
    //
    // TWO names, because two rules refuse this and only ONE of them is the binding. A non-allowlisted
    // name is refused by the project-file allowlist whatever directory it would have come from, so on
    // its own it cannot tell "the project file did not reach roots[0]/.env" from "the project file
    // could not have reached ANY .env" - it would pass even if the binding regressed. The allowlisted
    // arm is the one that still measures the BINDING: that name IS permitted to expand, so its silence
    // is attributable to the directory and to nothing else.
    //
    // It has to be one of the two EXACT names the allowlist holds, since a prefixed name is now
    // refused by the allowlist too and would collapse this arm back into the row above it.
    const allowlisted = "OPENCADRE_KEY";
    expect(process.env[VAR]).toBeUndefined();
    expect(process.env[allowlisted]).toBeUndefined();
    const home = tempDir("rx-rule-");
    const cwd = tempDir("rx-rule-cwd-");
    const xdg = path.join(home, ".config", "reasonix");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(path.join(xdg, ".env"), `${VAR}=from-xdg\n${allowlisted}=from-the-machine-wide-env\n`);

    // A local env object, NOT the shared `noEnv`: that one pins the two allowlisted names to "" and
    // `reasonixEnv` uses `??`, so an empty string would win over the .env value and this arm would
    // be measuring the pin instead of the binding. Passing {} leaves the .env as the only source.
    const env: NodeJS.ProcessEnv = { [VAR]: undefined };
    const byFile = new Map(reasonixCandidates(home, cwd, env, "linux"));
    expect(byFile.get(path.join(cwd, "reasonix.toml"))?.(VAR)).toBeUndefined();
    // The binding. This name IS permitted to expand, so the project candidate reaching `undefined`
    // here can only mean it did not read xdg/.env - the directory rule, isolated from the name rule.
    expect(byFile.get(path.join(cwd, "reasonix.toml"))?.(allowlisted)).toBeUndefined();
    // The known positive, without which the two lines above would read identically if the fixture
    // were simply not wired up: the SAME value IS reachable from that .env, through the root that
    // owns it. So the project candidate's silence is a refusal, not a missing value.
    expect(byFile.get(path.join(xdg, "config.toml"))?.(allowlisted)).toBe("from-the-machine-wide-env");
  });
});

describe("the hook and the reader resolve the SAME home", () => {
  /** Run `body` with the host's own Reasonix home out of the way, so the roots walked here are the
   * temp tree's and never the operator's real %APPDATA%\Reasonix. */
  const withOwnRoots = <T>(body: (home: string, roots: string[]) => T): T => {
    const saved = { REASONIX_HOME: process.env.REASONIX_HOME, APPDATA: process.env.APPDATA };
    try {
      delete process.env.REASONIX_HOME;
      const home = tempDir("rx-rule-");
      process.env.APPDATA = path.join(home, "roaming");
      const roots = reasonixRoots(home);
      for (const root of roots) expect(root.startsWith(home + path.sep)).toBe(true);
      return body(home, roots);
    } finally {
      if (saved.REASONIX_HOME === undefined) delete process.env.REASONIX_HOME;
      else process.env.REASONIX_HOME = saved.REASONIX_HOME;
      if (saved.APPDATA === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved.APPDATA;
    }
  };

  // Host-scoped on purpose, and worth stating rather than leaving to be discovered: these walk the
  // roots of the platform the suite is running on. On POSIX that is the two-root case that made the
  // divergence real; on Windows there is one root and the agreement holds trivially. The
  // platform-injected tests above are what carry evidence for both orders.
  it("agrees with the reader when every root exists - the reader wins from the canonical one", () => {
    withOwnRoots((home, roots) => {
      const cwd = tempDir("rx-rule-cwd-");
      const keys = roots.map((_, i) => `agt_rule_win${i}`);
      roots.forEach((root, i) => mkHome(root, keys[i]));
      const resolved = resolveHub({ client: "reasonix", home, cwd, env: noEnv });
      expect(resolved.key).toBe(keys[0]);
      expect(path.join(reasonixHome(home), "config.toml")).toBe(path.join(roots[0], "config.toml"));
    });
  });

  it("agrees with the reader when only the LAST root exists - the legacy-only install", () => {
    // The case a bare roots[0] would get wrong in the other direction: the hook has to follow the
    // reader to the root that actually holds the config, not name one that is not there.
    withOwnRoots((home, roots) => {
      const cwd = tempDir("rx-rule-cwd-");
      const last = roots[roots.length - 1];
      mkHome(last, "agt_rule_only_last");
      const resolved = resolveHub({ client: "reasonix", home, cwd, env: noEnv });
      expect(resolved.key).toBe("agt_rule_only_last");
      expect(path.join(reasonixHome(home), "config.toml")).toBe(path.join(last, "config.toml"));
    });
  });
});
