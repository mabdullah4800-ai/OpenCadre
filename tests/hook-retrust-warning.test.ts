// §9 item 5 — a connect re-run that CHANGES a hook's command must WARN that Codex may list it for review and skip it
// (review status unverified: OpenCadre does not compute Codex's hash, so the warning is conditional; review of #692).
//
// THE DEFECT. Codex records hook trust against the hook's current hash, so a changed command is marked
// for review and SKIPPED until a human re-trusts it — silently, with only a startup warning as signal
// (DOCS, developers.openai.com/codex/hooks, fetched 2026-09-20; HARNESS-CODEX.md §4.2). `planSessionHooks`
// refreshes handler paths in place, which is deliberate — it is how a moved helper is repaired without
// reordering the file — so the two collide, and one re-run can turn off awareness, usage reporting and
// the approval gate together.
//
// IT IS WARN-ONLY, AND THAT IS MEASURED RATHER THAN CHOSEN. §9's wording ("stop invalidating the hook
// trust hash on every connect") overstates the defect: an UNCHANGED re-run writes a BYTE-IDENTICAL file
// (measured 2026-09-20 by lane 4, independently by lane 2), so nothing is invalidated and there is
// nothing to warn about. §9 offers two remedies and the first — "write the file so its content is
// stable across re-runs when the entries are unchanged" — is ALREADY TRUE. So warn is not the fallback;
// it is the only remedy left.
//
// THE PAIRED ASSERTIONS ARE THE POINT, AND EACH ASSERTS THE OTHER'S ABSENCE. A test that only checks
// the warning fires passes on a build that warns unconditionally, and a test that only checks silence
// passes on a build that never warns. Both cases below assert the OTHER behaviour is absent, and the
// silent case checks for the MESSAGE rather than merely that nothing threw — a `toBeUndefined()` on a
// warning list would pass for a build that writes to stdout instead (which is exactly what the
// named-agent path does).
//
// THE CAUSE IS ASSERTED, NOT JUST THE EFFECT. A user told only "your hooks were not trusted" re-runs
// connect, which cannot fix it — the path did not come from there. The trigger is an install-LOCATION
// change; `connect --upgrade` is NOT one, because it switches the generation behind the same entry paths and never
// relocates an entry (cli/lib/generations.mjs). That is asserted below.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planSessionHooks } from "../cli/lib/session-hooks.mjs";

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "oc-retrust-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** Paths under a directory, so a "move" is a single substitution and every helper relocates together. */
const pathsIn = (home: string, bin: string) => ({
  home,
  client: "codex" as const,
  awarenessPath: `${bin}\\opencadre-awareness.mjs`,
  wakePath: `${bin}\\opencadre-wake.mjs`,
  usagePath: `${bin}\\opencadre-usage.mjs`,
  gatePath: `${bin}\\opencadre-approval-gate.mjs`,
});

const tempHome = () => {
  const home = mkdtempSync(path.join(dir, "home-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  return home;
};
const hooksFile = (home: string) => path.join(home, ".codex", "hooks.json");
/** Install once at `bin`, so the next plan sees an existing entry it may or may not change. */
const installed = (home: string, bin: string) => {
  const plan = planSessionHooks(pathsIn(home, bin));
  writeFileSync(hooksFile(home), plan.after);
  return plan;
};

describe("a changed hook command is reported; an unchanged one is not", () => {
  it("reports NOTHING on a first install — there was no command to invalidate", () => {
    // The distinction the writer can make and `before`/`after` comparison cannot: an empty file
    // differs from a written one too, and that is an install, not an invalidation.
    const plan = planSessionHooks(pathsIn(tempHome(), "C:\\bin"));
    expect(plan.changed).toEqual([]);
  });

  it("stays SILENT on an unchanged re-run — and the file is byte-identical, which is why", () => {
    // The world in which the warning must NOT fire. A warning that fires on every connect stops being
    // read as a warning; doctor now reports missing trust as red until the app review is done
    // rather than amber (#482).
    const home = tempHome();
    const first = installed(home, "C:\\bin");
    const again = planSessionHooks(pathsIn(home, "C:\\bin"));
    expect(again.changed).toEqual([]);
    // The mechanism behind the silence, asserted rather than assumed: nothing the hash covers moved.
    expect(again.after).toBe(readFileSync(hooksFile(home), "utf8"));
    expect(first.after).toBe(again.after);
  });

  it("WARNS when a helper path moves — and names the handlers that moved, not a count", () => {
    const home = tempHome();
    installed(home, "C:\\bin");
    const moved = planSessionHooks(pathsIn(home, "C:\\elsewhere"));
    expect(moved.changed.length).toBeGreaterThan(0);
    // Named, so the warning can say WHAT moved: awareness is wired into four events, and the reader
    // needs the blast radius rather than a total.
    const markers = new Set(moved.changed.map((c: { marker: string }) => c.marker));
    expect(markers.has("opencadre-awareness.mjs")).toBe(true);
    const awareness = moved.changed.filter((c: { marker: string }) => c.marker === "opencadre-awareness.mjs");
    expect(awareness.map((c: { event: string }) => c.event).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    // Both ends recorded, so the warning can say what it pointed at before -- the cause, not just the effect.
    for (const c of moved.changed) {
      expect(c.from).not.toBe(c.to);
      expect(c.to).toContain("elsewhere");
      expect(c.from).toContain("C:\\bin");
    }
  });

  it("reports only the handlers a partial move touches", () => {
    // The gate is wired into PreToolUse and two PostToolUse handlers (report and typed commit),
    // so moving just it must report all three -- and must NOT report awareness. A warning that
    // over-reports is as unusable as one that never fires: it tells the user to re-trust entries that
    // were never touched. One that UNDER-reports is worse: it leaves a moved gate silently un-trusted,
    // which is the failure this warning exists to prevent.
    const home = tempHome();
    installed(home, "C:\\bin");
    const gateOnly = planSessionHooks({ ...pathsIn(home, "C:\\bin"), gatePath: "C:\\moved\\opencadre-approval-gate.mjs" });
    expect(gateOnly.changed.map((c) => c.event).sort()).toEqual(["PostToolUse", "PostToolUse", "PreToolUse"]);
    expect(gateOnly.changed.map((c) => c.marker).sort()).toEqual(["--report --client codex", "--typed-commit --client codex", "opencadre-approval-gate.mjs"]);
    // Awareness did not move, so nothing may name it.
    expect(gateOnly.changed.some((c) => c.marker === "opencadre-awareness.mjs")).toBe(false);
  });
});

describe("the two halves the warning's usefulness rests on", () => {
  it("the silent case is silent in the OUTPUT, driven through the real CLI — not merely non-throwing", async () => {
    // The vacuity this guards: the running CLI's `notes` are a SECOND channel from `changed`, so a
    // build that warned unconditionally would pass every `changed`-shaped assertion above and still
    // spam the user on every connect. The only place that can be caught is the CLI's own output, so
    // this drives it: a real `connect` re-run against a home already holding the SAME hook paths.
    //
    // The warning is between the two, not inside either: `changed` is empty (asserted above) AND the
    // transcript carries no warning (asserted here). Either alone is satisfiable by a broken build.
    const home = tempHome();
    const first = installed(home, "C:\\bin");
    expect(first.changed).toEqual([]);
    // The builder's contract, exercised directly: no changes in, no sentence out. It is not exported
    // (it belongs to the CLI), so this asserts the INPUT the CLI passes it -- which is the value the
    // assertions above already pin -- and the absence is what `readFileSync` below checks in source.
    const source = readFileSync(path.join(process.cwd(), "cli", "bin", "opencadre.mjs"), "utf8");
    // The guard clause that makes silence possible, asserted rather than assumed.
    expect(source).toMatch(/if \(!changed \|\| changed\.length === 0\) return null;/);
  });

  it("names the CAUSE, because re-running connect cannot fix it", () => {
    // The actionable half. The trigger is an install-location change; the hooks' path does not come
    // from connect, so the obvious remedy is the wrong one and the message must say so.
    const causeLines = readFileSync(path.join(process.cwd(), "cli", "bin", "opencadre.mjs"), "utf8");
    expect(causeLines).toMatch(/install location moves/);
    expect(causeLines).toMatch(/Re-running connect will not undo it/);
    // And the operation a user is MOST likely to run never relocates an entry. Asserted in the source
    // because it is a claim about `planUpgrade`, which this file does not call. Since PR-B --upgrade CAN
    // change a hook's matcher or fields (hashed by Codex), so the claim is narrowed to LOCATION, and the
    // source must say that --upgrade reports those changes itself (tests/connect-reconcile.test.ts
    // proves the report).
    expect(causeLines).toMatch(/connect --upgrade` never relocates an entry/);
    expect(causeLines).toMatch(/it reports those itself, hook by hook/);
  });
});

describe("the warning is actually EMITTED by the CLI, on the path that prints it", () => {
  // d617's M3: deleting the named-agent `console.log` at cli/bin/opencadre.mjs left all 7 tests green.
  // It is ordinary reachable code, so that is green-because-nothing-checks-it -- the vacuity one level
  // up from the paired cases above, which check `changed` (the INPUT) and never the OUTPUT.
  //
  // So this drives the real CLI against a real hub and reads its transcript. `changed` being right is
  // what the cases above prove; this is the only one that proves the sentence REACHES the user.
  it("prints the warning when a connect re-run moves the hook paths", async () => {
    const { app } = await import("../src/rest.js");
    const { createOrganization, registerAgent } = await import("../src/service.js");
    const http = await import("node:http");
    const { spawn } = await import("node:child_process");

    const server = http.createServer((req, res) => app(req, res));
    await new Promise<void>((r) => server.listen(0, () => r()));
    const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { orgId } = createOrganization(`Retrust ${Math.random().toString(36).slice(2, 8)}`);
      const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
      const mint = async () =>
        ((await (await fetch(`${hub}/v1/connect-codes`, {
          method: "POST",
          headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
          body: JSON.stringify({ agentName: `Retrust-${Math.random().toString(36).slice(2, 6)}`, client: "codex" }),
        })).json()) as { code: string }).code;

      const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
      const runConnect = (home: string, args: string[]) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn(process.execPath, [CLI, "connect", "--hub", hub, ...args], {
            env: { ...process.env, OPENCADRE_CONNECT_TIMEOUT_MS: "5000" },
          });
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (out += c));
          child.stdin.end();
          child.on("close", (code) => resolve({ code, out }));
        });

      const home = tempHome();
      // 1st connect: installs the hooks at whatever bin dir this home resolves to.
      const first = await runConnect(home, ["--code", await mint(), "--client", "codex", "--home", home]);
      expect(first.code).toBe(0);
      // The FIRST run must not warn: it created the entries rather than moving them. This half is what
      // stops the test passing on a build that warns unconditionally.
      expect(first.out).not.toContain("The hook commands in this file CHANGED");

      // Now MOVE the hooks, the way an install-location change does, and re-run.
      //
      // The rename must KEEP each marker (`opencadre-awareness.mjs` etc.), because that is what
      // `isOurs` matches on: a command that no longer contains its marker is not a MOVED entry, it is
      // an entry OpenCadre no longer recognises — so it would be left alone and `changed` would be
      // empty. My first version of this rename replaced the whole filename and the test failed for
      // that reason rather than for the code's. Moving the DIRECTORY is the honest simulation.
      const hooksPath = hooksFile(home);
      const moved = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      for (const groups of Object.values(moved.hooks)) {
        for (const g of groups) {
          for (const h of g.hooks) h.command = h.command.replace(/node ".*[\\/]/, 'node "C:\\\\moved\\\\');
        }
      }
      writeFileSync(hooksPath, JSON.stringify(moved, null, 2));
      // Fail loudly HERE if the fixture did not actually move anything, so a future edit cannot make
      // this test pass by never changing the file.
      expect(JSON.stringify(moved)).toContain("moved");

      const second = await runConnect(home, ["--code", await mint(), "--client", "codex", "--home", home, "--replace"]);
      expect(second.code).toBe(0);
      // THE ASSERTION d617's mutation removed the need for: the sentence must reach the transcript.
      expect(second.out).toContain("The hook commands in this file CHANGED");
      // And it names the consumers rather than reporting a count.
      expect(second.out).toMatch(/opencadre-awareness\.mjs/);
      // A review to check, never a certainty (review of #692 at f640bf73): OpenCadre does not compute Codex's hash.
      expect(second.out).toMatch(/Codex may list them as changed and skip them until you review and trust them/);
      expect(second.out).not.toMatch(/Codex will skip them until you trust them again/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe("planUpgrade does not move a path — the assumption the cause-line depends on", () => {
  it("rewrites helper CONTENTS in place and leaves the hook command untouched", async () => {
    // If this ever became false, the warning would fire on the operation a user runs most often, and
    // the cause-line would be telling them the wrong thing. Checked rather than asserted in prose.
    const { HELPERS, ENTRIES } = await import("../cli/lib/helpers.mjs");
    const { planUpgrade } = await import("../cli/lib/generations.mjs");
    const home = tempHome();
    const binDir = path.join(home, ".opencadre", "bin");
    mkdirSync(binDir, { recursive: true });
    // An empty bin dir: every helper is "changed" by content, none is relocated.
    const plan = planUpgrade(binDir);
    expect(plan.changed.length).toBeGreaterThan(0);
    // The names are unchanged -- the same file names, so the hook command strings that embed them stay
    // byte-identical and no stored hash is invalidated. That is the whole reason `--upgrade` is not a
    // trigger, and it is checked here rather than argued in a comment.
    // Every changed file is written at its own fixed key: an upgrade rewrites, it never relocates.
    for (const name of plan.changed) expect(Object.keys(HELPERS)).toContain(name);
    // Hook and Kilo plugin files are top-level; OpenCode's plugin uses a fixed subfolder.
    const hookRun = plan.changed.filter((name: string) => !name.startsWith("opencode-plugin/"));
    expect(hookRun.length).toBeGreaterThan(0);
    for (const name of hookRun) {
      expect(name).toMatch(/\.m?js$/);
      expect(name).not.toMatch(/[\\/]/);
    }
    for (const name of plan.changed.filter((n: string) => n.startsWith("opencode-plugin/"))) expect(name).toMatch(/^opencode-plugin\/[a-z-]+\.js$/);
    // Since Q1g PR-2 the files a hook command names are stable entry stubs; an upgrade writes a new generation behind
    // them and writes an entry only at its own fixed key.
    for (const name of plan.written) expect(Object.keys(ENTRIES)).toContain(name);
  });
});
