// `opencadre doctor --client <tool>` for every client — and, more importantly, what it does when it
// CANNOT check one.
//
// WHY A THREE-VALUED OUTCOME. LAUNCH-CLIENT-GATE.md §1 makes the fleet's launch conditional on six
// capabilities being measured on a real install, and §3 says doctor "is the instrument every later
// cell is checked with". Three of the gate's tools (Cursor, Grok, Antigravity) are not installed on
// a fleet machine, so "this machine cannot check it" will be the COMMON state — and a report that
// renders it as a red row will be read as a product defect by whoever runs it, while a report that
// omits the row lets a tool pass the gate by being absent. Both are failures of the instrument, not
// of the tool.
//
// So the outcome is `pass` / `fail` / `not-measured`, and `not-measured` is neither: it exits 2,
// never 0, and it says which of the two causes applied — the tool is not served yet, or there is no
// config to read.
//
// The codex-behaviour tests live in codex-app-connect.test.ts and are deliberately NOT repeated
// here: they pin codex byte-for-byte, and they must pass untouched for this work to be a
// parameterisation rather than a rewrite. This file covers only what is new.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.OPENCADRE_CONNECT_TIMEOUT_MS = "3000";

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
let EMPTY_PATH: string;
let dir: string;

/** Async spawn, PATH emptied so no real client binary is found or touched — the same idiom
 * codex-app-connect.test.ts uses, and async because a sync spawn would deadlock a hub in-process. */
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

const tempHome = () => mkdtempSync(path.join(dir, "home-"));
const doctor = (home: string, client: string, ...extra: string[]) =>
  run(["doctor", "--client", client, "--home", home, ...extra]);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-doctor-all-"));
  EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-doctor-path-"));
});
afterAll(() => {
  for (const d of [dir, EMPTY_PATH]) rmSync(d, { recursive: true, force: true });
});

describe("a client that cannot be checked reports not-measured, never a pass", () => {
  it("exits 2 — not 0 — for a client still being measured, and names the cause", async () => {
    // The central assertion. A measuring client is 'recognized, not served' per the registry, so
    // there is nothing on a machine to inspect. Exit 0 here would let it read as a pass; exit 1
    // would report a product fault for a tool nobody claimed was working yet.
    const home = tempHome();
    const r = await doctor(home, "reasonix");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not set up yet/);
    expect(r.out).toMatch(/This is NOT a failure/);
    expect(r.out).toMatch(/verdict=not_measured/);
    expect(r.out).toMatch(/reason=not-served/);
    // And it must not claim any capability result at all.
    expect(r.out).not.toMatch(/\[green\]/);
  });

  it("exits 2 for a client with no config writer, naming that as the cause instead", async () => {
    // A DIFFERENT cause with the same outcome. reasonix is measuring AND has no writer; the registry's
    // hasConfigWriter comment records that clientConfigFile throws a raw TypeError for it. The
    // guard must produce a refusal in words rather than a crash, and the two causes must stay
    // distinguishable because they have different owners.
    const home = tempHome();
    const r = await doctor(home, "reasonix");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not set up yet|No config writer/);
    // The specific failure this guard exists to prevent: a stack trace where a sentence belongs.
    expect(r.err).not.toMatch(/TypeError/);
    expect(r.err).not.toMatch(/reading 'path'/);
  });

  it("is machine-readable: a caller reading only the summary line cannot mistake it for a pass", async () => {
    // 4e32's point, asserted rather than intended. Someone scripting the gate will parse the last
    // line, not read the prose, so the third state must be IN that line.
    const home = tempHome();
    const r = await doctor(home, "reasonix");
    const summary = r.out.trim().split("\n").pop() ?? "";
    expect(summary).toMatch(/verdict=not_measured/);
    expect(summary).not.toMatch(/verdict=healthy/);
    expect(summary).toMatch(/client=reasonix/);
  });

  it("guards a writerless client that is NOT measuring — the one client where this guard is the only one", async () => {
    // 7570's mutation, and it found a real hole: forcing `hasConfigWriter` true left the suite GREEN,
    // because every writerless client except one is ALSO `measuring: true`, so the MEASURING check
    // fires first and the hasConfigWriter guard is never reached. Two guards, one shadowing the
    // other — removing the inner one changes nothing observable, which is concealed-by-overlap.
    //
    // `dsh` is the exception: measuring:false AND hasConfigWriter:false, so for it the guard is the
    // ONLY thing between a machine and `Cannot read properties of undefined (reading 'path')`.
    // Verified by mutation rather than argued: with the guard disabled, dsh exits 1 with that raw
    // TypeError on stderr; with it, exit 2 and a sentence. This test is what keeps that true.
    const { CLIENT_NAMES, MEASURING_CLIENTS, DOCTOR_CHECKS } = await import("../scripts/opencadre-clients.mjs");
    const { hasConfigWriter } = await import("../cli/lib/clients.mjs");
    // The premise, asserted rather than assumed — if a future client change makes every writerless
    // client measuring, this test should FAIL LOUDLY rather than silently stop covering anything.
    const writerlessNotMeasuring = CLIENT_NAMES.filter((n: string) => !hasConfigWriter(n) && !MEASURING_CLIENTS.includes(n));
    // Goose has no NAMED-AGENT writer either, but doctor reads its device-path config.yaml with a reader of its own
    // (readGooseServer), so the guard does not apply to it; tests/goose-harness.test.ts covers its doctor run.
    // Grok likewise: its config.toml is read with the Codex table reader (tests/grok-harness.test.ts covers it).
    // Devin too: its mcp_config.json is read by readExistingServer's own branch (tests/devin-harness.test.ts).
    expect(writerlessNotMeasuring).toEqual(["dsh", "goose", "devin", "droid", "vibe", "crush", "grok"]);

    for (const client of writerlessNotMeasuring.filter((n: string) => !["goose", "grok", "devin", "droid", "vibe", "crush"].includes(n))) {
      const home = tempHome();
      const r = await doctor(home, client);
      expect(DOCTOR_CHECKS[client].served).toBe(true); // dsh IS served; that is why it gets this far
      expect({ client, code: r.code }).toEqual({ client, code: 2 });
      expect(r.out).toMatch(/reason=no-reader/);
      expect(r.out).toMatch(/No config writer/);
      // The specific failure this guard exists to prevent, and the one the mutation produced.
      expect({ client, typeError: /TypeError|reading 'path'/.test(r.err) }).toEqual({ client, typeError: false });
    }
  });

  it("marks the codex-only inbox skill inapplicable rather than missing on another client", async () => {
    // `inbox_skill=missing` on a client that never had one is a claim about the client, not about
    // this machine. It reads as a fault and is not one.
    const home = tempHome();
    const r = await doctor(home, "claude-code");
    expect(r.out).not.toMatch(/inbox_skill=missing/);
    expect(r.out).toMatch(/inbox_skill=n\/a/);
  });
});

describe("EVERY measuring client is not-measured, never 'unknown client'", () => {
  it("iterates the registry, so a client added later cannot slip through as an omission", async () => {
    // This is the general form of a real defect: #445 added `opencode` to the registry while this
    // branch was open, and at the merged head `doctor --client opencode` still printed "unknown
    // client" (exit 2) — an OMISSION wearing the costume of a refusal. Both are exit 2, so only the
    // stderr text separates them, which is why the assertion is on the text and not the code.
    //
    // Driven from MEASURING_CLIENTS rather than a hand-written list: a list would have needed
    // updating by whoever added the client, which is the discipline that already failed once here.
    // The coverage test in opencadre-config.test.ts keeps this set equal to the registry's.
    const { MEASURING_CLIENTS } = await import("../scripts/opencadre-clients.mjs");
    expect(MEASURING_CLIENTS.length).toBeGreaterThan(0); // a guard that iterates nothing proves nothing

    for (const client of MEASURING_CLIENTS) {
      const home = tempHome();
      const r = await doctor(home, client);
      // Exit 2, and the two things that must be true of it:
      expect({ client, code: r.code }).toEqual({ client, code: 2 });
      expect({ client, notMeasured: /not_measured/.test(r.out) }).toEqual({ client, notMeasured: true });
      // ...and the thing that must NOT be:
      expect({ client, unknown: /unknown client/.test(r.err) }).toEqual({ client, unknown: false });
    }
  });
});

describe("an unknown client is refused as unknown, not as 'codex only'", () => {
  it("names the valid set and exits 2", async () => {
    // The old message was "doctor supports --client codex only" for EVERY non-codex value,
    // including names that are not clients at all — so a typo and a real client got the same
    // unhelpful sentence.
    const home = tempHome();
    const r = await doctor(home, "nonsense");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown client "nonsense"/);
    expect(r.err).toMatch(/claude-code/);
    expect(r.err).not.toMatch(/codex only/);
  });

  it("refuses a name that is not a client at all, by name", async () => {
    // Not a registry client in any state. This is a true unknown, unlike a measuring client — which
    // is why the assertion is the error TEXT and not just the exit code, since both are 2.
    const home = tempHome();
    const r = await doctor(home, "notatool");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown client "notatool"/);
  });
});

describe("the two LABELS maps agree, because a duplicated per-client fact drifts", () => {
  it("covers every registry client, in BOTH files, with the same string", async () => {
    // Found by the #445 merge: that change added `opencode` to cli/bin/opencadre.mjs's LABELS while
    // cli/lib/doctor.mjs still held only `reasonix`, so the two disagreed — one printed "OpenCode",
    // the other the raw slug. A third copy of a per-client fact is exactly the drift this repo's
    // client-table history is about, so it is checked rather than trusted.
    //
    // Read from the SOURCE TEXT, because neither map is exported and exporting one just to test it
    // would change the module's surface for a test's convenience.
    const { CLIENT_NAMES } = await import("../scripts/opencadre-clients.mjs");
    const readMap = (file: string) => {
      const line = readFileSync(path.join(process.cwd(), file), "utf8").split("\n").find((l) => l.startsWith("const LABELS = "));
      expect(line, `${file} must declare a LABELS map`).toBeTruthy();
      const map: Record<string, string> = {};
      // Keys may be quoted (`"claude-code"`) or bare (`codex`), since a dash forces quotes and a
      // plain identifier does not. Matching only quoted keys silently collected four of nine.
      for (const m of (line ?? "").matchAll(/"?([a-z-]+)"?:\s*"([^"]+)"/g)) map[m[1]] = m[2];
      return map;
    };
    const inDoctor = readMap("cli/lib/doctor.mjs");
    const inCli = readMap("cli/bin/opencadre.mjs");

    // Every registry client has a human name in both, so no client is ever printed as a raw slug...
    for (const name of CLIENT_NAMES) {
      expect({ name, doctor: inDoctor[name] }).toEqual({ name, doctor: inDoctor[name] ?? undefined });
      expect(inDoctor[name], `cli/lib/doctor.mjs is missing a label for ${name}`).toBeTruthy();
      expect(inCli[name], `cli/bin/opencadre.mjs is missing a label for ${name}`).toBeTruthy();
    }
    // ...and the two maps are identical, which is the assertion that would have caught #445.
    expect(inDoctor).toEqual(inCli);
  });
});

describe("the parameterisation is real, not a rename", () => {
  it("reports the client it was ASKED for, and derives the config path per client", async () => {
    // The old CLI dropped the client value before runDoctor was reached, so the doctor literally
    // could not know what it had been asked about. This asserts the value survives the plumbing.
    //
    // Only a SERVED client reaches the config-reading path, so the path assertion uses
    // claude-code — the one non-codex client with both a writer and served status. antigravity is
    // measuring, so it takes the unmeasured early return and prints no path at all, which is
    // covered by its own case above.
    const home = tempHome();
    const r = await doctor(home, "claude-code");
    expect(r.out).toMatch(/client=claude-code\b/);
    expect(r.out).toMatch(/\.claude\.json/);
    // The path must be the CLIENT's, not a codex literal. This line used to say
    // ~/.codex/config.toml whatever client was asked for.
    expect(r.out).not.toMatch(/~\/\.codex\/config\.toml/);
  });

  it("still defaults to codex when --client is omitted", async () => {
    // Existing muscle memory from the 5-minute path: `opencadre doctor` alone. Its printed hint
    // says `--client codex` and it must keep working.
    const home = tempHome();
    const r = await run(["doctor", "--home", home]);
    expect(r.out).toMatch(/client=codex\b/);
  });
});
