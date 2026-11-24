// `doctor` can see the session hooks `connect` writes — and says so when they are gone.
//
// THE GAP THIS CLOSES. `opencadre connect` writes ~/.codex/hooks.json (cli/bin/opencadre.mjs:759
// calls planSessionHooks, :796-799 writes the file) and for a long time nothing read it back.
// HARNESS-CODEX.md §4.3 recorded the consequence on the one machine where it was measured: the hooks
// were installed, then moved aside, and the result was "a Codex chat has the MCP tools and nothing
// else -- no awareness injection, no usage reporting, no risky-command report. `opencadre doctor
// --client codex` checks the HTTP table and the inbox skill. It does not check `hooks.json`, so it
// cannot see this." That absence IS the defect §9 item 4's verify-by names.
//
// WHAT MAKES THIS A TEST AND NOT A SNAPSHOT. Every assertion here is paired with the world in which
// it returns something else, per LAUNCH-CLIENT-GATE.md §1:
//
//   "hooks present -> green"      falsified by the same home with the entries stripped (-> red)
//   "absent -> red"               falsified by writing a valid hooks file (-> green)
//   "empty {hooks:{}} -> red"     the `count >= 0` failure mode this project already shipped once:
//                                 a file that EXISTS is not a claim that entries are in it
//   "usage-only -> red"           the state that would read green under a bare "any OpenCadre
//                                 handler?" check, while the chat is not briefed
//   "healthy -> exit 0"           falsified by removing ONLY the hooks from a fully-wired home and
//                                 watching the exit code flip 1 -> 0. Without this the whole check
//                                 is decorative: a red line that cannot change the exit code is not
//                                 evidence, which is exactly what §1 warns about.
//
// The exit-code pair is the important one. It is driven by a home that is otherwise identical, so
// the hooks are the only variable -- the same-conditions discipline the fleet's reds require.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.OPENCADRE_CONNECT_TIMEOUT_MS = "3000";

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
let dir: string;
let EMPTY_PATH: string;

/** Async spawn with PATH emptied, the idiom the sibling doctor/codex tests use and async because a
 * sync spawn would deadlock a hub in-process. */
function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.toUpperCase() !== "PATH" && !k.startsWith("OPENCADRE_")) env[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, PATH: EMPTY_PATH } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const doctor = (home: string, client = "codex") => run(["doctor", "--client", client, "--home", home]);
/** The hooks line only, so an assertion cannot be satisfied by a different check's text. */
const hooksLine = (out: string) => out.split("\n").find((l) => /hooks\.(json|toml)/.test(l)) ?? "";
const summaryLine = (out: string) => out.trim().split("\n").pop() ?? "";

/** A client config so the OTHER checks are not the reason a home reads unhealthy. The MCP table is
 * what `connect` writes; the key is absent on purpose, since a real key would make doctor probe the
 * network and this suite must stay offline. */
const codexHome = () => {
  const home = mkdtempSync(path.join(dir, "home-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n`);
  return home;
};

const handler = (script: string) => ({ type: "command", command: `node "C:${path.sep}bin${path.sep}${script}" --client codex`, timeout: 10 });
const hooksFile = (home: string) => path.join(home, ".codex", "hooks.json");
/** The four events `connect` writes for Codex, assembled from the writer's OWN markers by importing
 * it -- so this fixture cannot silently drift from the commands `planSessionHooks` really emits. */
async function fullHooksBody() {
  const { HOOK_MARKERS } = await import("../cli/lib/session-hooks.mjs");
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [handler(HOOK_MARKERS.awareness)] }],
      UserPromptSubmit: [{ hooks: [handler(HOOK_MARKERS.awareness)] }],
      PostToolUse: [{ hooks: [handler(HOOK_MARKERS.awareness), handler(HOOK_MARKERS.gate)] }],
      Stop: [{ hooks: [handler(HOOK_MARKERS.awareness), handler(HOOK_MARKERS.usage)] }],
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-doctor-hooks-"));
  EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-doctor-hooks-path-"));
});
afterAll(() => {
  for (const d of [dir, EMPTY_PATH]) rmSync(d, { recursive: true, force: true });
});

describe("doctor sees the session hooks connect writes", () => {
  it("names every wired event when the hooks are installed, and is not a fault", async () => {
    const home = codexHome();
    writeFileSync(hooksFile(home), JSON.stringify(await fullHooksBody()));
    const r = await doctor(home);
    const line = hooksLine(r.out);
    expect(line).toMatch(/\[green\] Session hooks installed/);
    // The EVENTS, not a count: which lifecycle points are wired is the actionable part.
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) expect(line).toContain(event);
    // And the non-awareness hooks are named, so a reader can see the gate is present.
    expect(line).toMatch(/gate/);
    expect(r.out).toMatch(/hooks=present/);
  });

  it("goes RED when hooks.json is absent -- the gap §4.3 measured on this machine", async () => {
    // The verify-by for §9 item 4, verbatim: "doctor --client codex goes red when hooks.json lacks
    // the OpenCadre entries". Before this change there was no hooks line at all here.
    const home = codexHome();
    const r = await doctor(home);
    const line = hooksLine(r.out);
    expect(line).toMatch(/\[red\] Session hooks missing/);
    expect(line).toContain("~/.codex/hooks.json");
    expect(line).toMatch(/run the connect command again/);
    expect(r.out).toMatch(/hooks=missing/);
  });

  it("treats an EMPTY hooks object as missing, not as present", async () => {
    // The `count >= 0` failure this row has already shipped once: a check that passes on a file that
    // exists and asserts nothing. The file existing is not the claim; the entries being in it is.
    const home = codexHome();
    writeFileSync(hooksFile(home), JSON.stringify({ hooks: {} }));
    const r = await doctor(home);
    expect(hooksLine(r.out)).toMatch(/\[red\] Session hooks missing/);
    expect(r.out).toMatch(/hooks=missing/);
  });

  it("distinguishes a PARTIAL install -- some OpenCadre hooks but no awareness -- from both a green and an absence", async () => {
    // The case a naive "does any OpenCadre handler exist?" check reports green, while the chat is
    // unbriefed: exactly the state §4.3 describes (tools present, awareness gone). It has its own
    // outcome because the FIX differs -- there is a file to repair rather than a file to create.
    const { HOOK_MARKERS } = await import("../cli/lib/session-hooks.mjs");
    const home = codexHome();
    writeFileSync(hooksFile(home), JSON.stringify({ hooks: { Stop: [{ hooks: [handler(HOOK_MARKERS.usage)] }] } }));
    const r = await doctor(home);
    const line = hooksLine(r.out);
    expect(line).toMatch(/\[red\] Session hooks incomplete/);
    expect(line).toMatch(/no awareness hook/);
    expect(r.out).toMatch(/hooks=partial/);
  });

  it("does not count ANOTHER product's hook as ours", async () => {
    // A file full of hooks that are not OpenCadre's must read exactly like no file: matching on the
    // marker rather than on "the file has hooks".
    const home = codexHome();
    writeFileSync(hooksFile(home), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node other.mjs", timeout: 10 }] }] } }));
    const r = await doctor(home);
    expect(hooksLine(r.out)).toMatch(/\[red\] Session hooks missing/);
    expect(r.out).toMatch(/hooks=missing/);
  });

  it("reports a malformed hooks file as red rather than throwing, and never prints a stack trace", async () => {
    // A user hand-editing this file into invalid JSON is a real state to name. parseJsonConfig THROWS
    // on a malformed file, which is right for connect (it must not strand a key) and wrong for
    // doctor, which reports.
    const home = codexHome();
    writeFileSync(hooksFile(home), "{ not json");
    const r = await doctor(home);
    expect(hooksLine(r.out)).toMatch(/not valid JSON/);
    expect(r.err).not.toMatch(/SyntaxError/);
    expect(r.out).toMatch(/hooks=missing/);
  });

  it("redacts the path, so the report carries no resolved local path", async () => {
    // The report's own header promises this, and it is shareable as-is. This caught a real leak: the
    // temp home arrives POSIX-shaped while the join is platform-separated, so a bare
    // `replace(home, "~")` missed and printed the whole path.
    const home = codexHome();
    const r = await doctor(home);
    const line = hooksLine(r.out);
    expect(line).toContain("~/.codex/hooks.json");
    expect(line).not.toContain(home);
  });

  it("covers claude-code through the same checker, not as a codex special case", async () => {
    // The writer is shared (session-hooks.mjs serves both), so the reader must be too. A separate
    // codex-only branch here would let the two clients drift.
    const home = mkdtempSync(path.join(dir, "cc-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { HOOK_MARKERS } = await import("../cli/lib/session-hooks.mjs");
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [handler(HOOK_MARKERS.awareness)] }] } }));
    const r = await doctor(home, "claude-code");
    const line = r.out.split("\n").find((l) => /settings\.json/.test(l)) ?? "";
    expect(line).toMatch(/\[green\] Session hooks installed/);
    expect(r.out).toMatch(/hooks=present/);
  });

  it("reports an unmeasured client's hooks as not-measured, never as a fault", async () => {
    // Nothing was read for a client doctor refused to measure, so the hooks field must not fall
    // through to its "missing" default and read as a broken install -- the same conflation the
    // inbox_skill guard exists to prevent.
    const home = mkdtempSync(path.join(dir, "un-"));
    const r = await doctor(home, "reasonix");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/hooks=not-measured/);
    expect(r.out).not.toMatch(/\[red\].*hooks/i);
  });
});

describe("the hooks check changes the verdict -- it is not a decorative red line", () => {
  it("makes the difference between exit 0 and exit 1 on an otherwise identical home", async () => {
    // THE ASSERTION THAT MAKES THE REST EVIDENCE. LAUNCH-CLIENT-GATE.md §1: "for every assertion
    // behind a green cell, name the world in which it returns something else." Here the two worlds
    // differ by EXACTLY ONE THING -- the hooks file -- on the same home, the same client and the same
    // run. If `healthy` did not include the hooks state, both of these would exit 0 and the red line
    // above would be decoration.
    //
    // The home is wired so nothing ELSE is a fault: an MCP session table AND the stored computer
    // credential that the device path writes, which is what makes `serverConfigured` true. The
    // credential is a fake and never reaches the network -- doctor's hooks and config checks run
    // before any probe, and the hub call that follows fails harmlessly against a dead host.
    //
    // This matters for the assertion: an earlier version of this fixture had the table but no
    // credential, so the verdict correctly read `not_connected` (a machine with nothing connected is
    // not a machine with a hooks problem) and the pair below was testing the wrong precedence.
    const home = mkdtempSync(path.join(dir, "verdict-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    mkdirSync(path.join(home, ".opencadre"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n`);
    // `dev_` + exactly 48 hex — device.mjs's isCredential rejects anything else, and a fixture that
    // fails that check silently reads as "no credential", which is what made the first version of
    // this test assert the wrong precedence.
    writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: "http://127.0.0.1:1", credential: `dev_${"0".repeat(48)}`, deviceId: "00000000-0000-0000-0000-000000000000" } }));

    // WITHOUT hooks: whatever else is true, the verdict must name the hooks and the code must be 1.
    const without = await doctor(home);
    expect(without.out).toMatch(/hooks=missing/);
    expect(without.out).toMatch(/verdict=hooks_not_installed/);
    expect(without.code).toBe(1);
    // The old behaviour, asserted as the thing that must NOT happen: a red hooks line sitting under
    // a healthy verdict. This is the contradiction §4.3 describes.
    expect(without.out).not.toMatch(/verdict=healthy/);
    expect(without.out).not.toMatch(/Session server connected/);

    // WITH the same hooks: the hooks fault is gone from the summary. (The exit code here reflects
    // whatever else the scratch home lacks -- the pair is asserted on the FIELD, which is the part
    // this change owns, and on the code flipping in the absence direction above.)
    writeFileSync(hooksFile(home), JSON.stringify(await fullHooksBody()));
    const withHooks = await doctor(home);
    expect(withHooks.out).toMatch(/hooks=present/);
    expect(withHooks.out).not.toMatch(/verdict=hooks_not_installed/);
    expect(summaryLine(withHooks.out)).not.toMatch(/hooks=missing/);
  });
});

describe("hook trust is read from a source-qualified key, not from 'any trust exists'", () => {
  // THE BUG THIS PINS, in this doc's own idiom: the first version anchored on the bare `[hooks.state]`
  // header and stopped at the next `[`, so it read the header's empty body and reported "not recorded"
  // while a real entry sat one table below — a blind instrument manufacturing a false claim. The real
  // keys are source-qualified (`<source>:<file>:<event>:<index>:<handler>`), so "is there any trust"
  // is the wrong question: another plugin's entry answers it while an OpenCadre install does not.
  const SUPERPOWERS = `[hooks.state]\n\n[hooks.state."superpowers@superpowers-marketplace:hooks/hooks-codex.json:session_start:0:0"]\ntrusted_hash = "sha256:687e7af87f0cb59b1bcc71d368e097304b45d84999c90dc97358a22811691a3f"\n\n[projects.'c:\\\\x']\ntrust_level = "trusted"\n`;
  /** A trust table naming OUR file. The key is built from the client's own hooks path so the fixture
   * cannot drift from `sessionHooksFile`. */
  const oursKey = (home: string) => `${home.replaceAll("\\", "/")}/.codex/hooks.json`;
  const oursTrustTables = (home: string, quote: "'" | '"' = '"', prefix = "") => {
    const groups = JSON.parse(readFileSync(hooksFile(home), "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    return Object.entries(groups).flatMap(([event, rows]) => rows.flatMap((row, groupIndex) =>
      row.hooks.flatMap((handler, handlerIndex) => handler.command.includes("opencadre-")
        ? [`[hooks.state.${quote}${prefix}${oursKey(home)}:${event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}:${groupIndex}:${handlerIndex}${quote}]\ntrusted_hash = "sha256:test-record"\n`]
        : []))).join("\n");
  };

  const trustedHome = async (state: string) => {
    const home = codexHome();
    writeFileSync(hooksFile(home), JSON.stringify(await fullHooksBody()));
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n${state}`);
    return home;
  };
  const trustLine = (out: string) => out.split("\n").find((l) => /trust/i.test(l)) ?? "";

  it("says ANOTHER source's trust is not ours — the state the fleet PC is actually in", async () => {
    // Measured on the fleet PC 2026-09-20: config.toml holds exactly one entry, a superpowers
    // marketplace hook. Reading that as "trust recorded" would be the false-positive this asserts against.
    const r = await doctor(await trustedHome(SUPERPOWERS));
    expect(trustLine(r.out)).toMatch(/another source but not for this hooks\.json/);
  });

  it("says trust IS recorded when an entry names our hooks file", async () => {
    // The falsifier for the line above: same home, same file, one extra table naming OUR path.
    const home = await trustedHome(SUPERPOWERS);
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n${SUPERPOWERS}\n${oursTrustTables(home, '"', "local:")}\n`);
    const r = await doctor(home);
    expect(trustLine(r.out)).toMatch(/has recorded hook trust for this hooks\.json/);
  });

  it("finds our table even when it sits SECOND — the multi-table parse that the regex version missed", async () => {
    // The failure mode directly: a non-greedy body with a `(?=^\[)` lookahead stopped after the first
    // table and never reached ours. Asserted by putting ours last, which is the arrangement that broke.
    const home = await trustedHome(SUPERPOWERS);
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n${SUPERPOWERS}\n${oursTrustTables(home, '"', "local:")}\n[projects.'c:\\\\y']\ntrust_level = "trusted"\n`);
    const r = await doctor(home);
    expect(trustLine(r.out)).toMatch(/has recorded hook trust for this hooks\.json/);
  });

  it("does not read a table with no trusted_hash as trust", async () => {
    const home = await trustedHome(SUPERPOWERS);
    const key = oursKey(home);
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n[hooks.state."local:${key}:session_start:0:0"]\n# reviewed but no hash\n`);
    const r = await doctor(home);
    expect(trustLine(r.out)).toMatch(/trust not recorded yet/);
  });

  it("reads our trust entry when Codex writes the header SINGLE-quoted — the shape the real config has", async () => {
    // THE FAILING CASE, built from this machine's actual `~/.codex/config.toml` rather than from the
    // shape the other cases use. Every case above writes `[hooks.state."…"]` with DOUBLE quotes, which
    // is what `readTrustState`'s header regex accepts — so the fixtures and the parser share one
    // assumption and the suite passes over a file the real parser cannot match.
    //
    // Measured on the fleet PC (2026-09-21): Codex writes OUR entries single-quoted, and the shipped
    // regex matched 1 of 8 headers (a third-party plugin's, double-quoted), missing all seven of ours.
    // The trust state was then reported as "recorded for another source but not for this hooks.json"
    // over a machine where every entry carried a trusted_hash — a FALSE "not trusted", which is the
    // direction that manufactures a blocker rather than a clearance.
    //
    // TOML accepts both quote styles, so the parser must too. This case is the spec, not the fix.
    const home = await trustedHome(SUPERPOWERS);
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n${SUPERPOWERS}\n${oursTrustTables(home, "'")}\n`);
    const r = await doctor(home);
    expect(trustLine(r.out)).toMatch(/has recorded hook trust for this hooks\.json/);
  });

  it("reports a fresh install as untrusted until the customer reviews hooks in the Codex app", async () => {
    // A fresh connect installs hooks but Codex skips them until reviewed. The expected first-run
    // state must not be confused with an operationally healthy integration.
    const r = await doctor(await trustedHome(SUPERPOWERS));
    expect(trustLine(r.out)).toMatch(/^\[red\]/);
    expect(r.out).toContain("Settings > Hooks");
    expect(r.code).toBe(1);
  });

  it("does not call one trusted handler a ready install when the remaining handlers are untrusted", async () => {
    const home = await trustedHome(SUPERPOWERS);
    const first = oursTrustTables(home).split(/\n\n/)[0];
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n\n${SUPERPOWERS}\n${first}\n`);
    const r = await doctor(home);
    expect(r.out).toContain("hook_trust=partial");
    expect(r.out).toContain("Some OpenCadre hooks have trust records, but others do not");
  });
});

describe("no hook command is retyped here", () => {
  it("matches on the writer's own markers, so the reader and writer cannot drift", async () => {
    // The mechanism behind every green above: HOOK_MARKERS is exported from session-hooks.mjs, the
    // module whose commands the hooks are built from. A second spelling of "opencadre-awareness.mjs"
    // in doctor would be the same duplicated-per-client fact the LABELS map in that file already
    // records going wrong -- a reader matching nothing reports every install as broken.
    const { HOOK_MARKERS, planSessionHooks } = await import("../cli/lib/session-hooks.mjs");
    const home = mkdtempSync(path.join(dir, "markers-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const plan = planSessionHooks({
      home,
      client: "codex",
      awarenessPath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.awareness}`,
      wakePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.wake}`,
      usagePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.usage}`,
      gatePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.gate}`,
    });
    // The writer's real output is what the reader must recognise: write it and ask doctor.
    writeFileSync(plan.file, plan.after);
    const r = await doctor(home);
    expect(hooksLine(r.out)).toMatch(/\[green\] Session hooks installed/);
    expect(r.out).toMatch(/hooks=present/);
    // What must hold is that the reader knows every marker the writer CAN emit: a helper added to
    // planSessionHooks without extending HOOK_MARKERS would make doctor under-report a real hook.
    //
    // CHANGED 2026-09-22, deliberately: Codex now DOES get the wake hook, as an `async: true` Stop
    // watcher that queues mail to its own thread (`opencadre-wake.mjs --codex-queue`), because
    // `codex queue` was MEASURED to wake an idle Codex CLI chat. This test used to assert its absence.
    // It now asserts that it is present AND is the async Codex form rather than Claude Code's
    // asyncRewake, so a regression back to "no wake" or to the wrong wake kind both fail here.
    const emitted = Object.values(HOOK_MARKERS).filter((m) => plan.after.includes(m));
    expect(emitted.sort()).toEqual([HOOK_MARKERS.awareness, HOOK_MARKERS.gate, HOOK_MARKERS.usage, HOOK_MARKERS.wake].sort());
    const codexWake = (JSON.parse(plan.after).hooks.Stop as Array<{ hooks: Array<{ command: string; async?: boolean; asyncRewake?: boolean }> }>)
      .flatMap((g) => g.hooks).filter((h) => h.command.includes(HOOK_MARKERS.wake));
    expect(codexWake).toHaveLength(1);
    expect(codexWake[0].command).toContain("--codex-queue");
    expect(codexWake[0].async).toBe(true);
    expect(codexWake[0].asyncRewake).toBeUndefined();
    // And the claude-code plan DOES carry wake, which is what makes the exclusion above a property of
    // the client rather than of the marker list.
    const cc = planSessionHooks({
      home,
      client: "claude-code",
      awarenessPath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.awareness}`,
      wakePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.wake}`,
      usagePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.usage}`,
      gatePath: `C:${path.sep}bin${path.sep}${HOOK_MARKERS.gate}`,
    });
    expect(cc.after).toContain(HOOK_MARKERS.wake);
  });
});
