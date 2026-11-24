// `doctor` reports helpers in ~/.opencadre/bin that don't match the CLI running it, and that changes its verdict.
//
// THE GAP THIS CLOSES, measured 2026-09-23 on the fleet PC: a fix on main (e335e02, two Codex chats = two agents) did
// nothing on a machine whose helpers predated it, and `doctor --client codex` stayed green and exit 0 throughout. Only
// `connect --upgrade` changed the outcome.
//
// Per LAUNCH-CLIENT-GATE.md §1, each assertion is paired with the world that flips it. The home is FULLY wired and a
// local stand-in hub accepts its credential, so with matching helpers doctor reaches its best verdict (`hook_trust_unverified`, exit 3, since recorded Codex trust is never verified); the same
// home with one differing helper must reach `helpers_mismatch` and exit 1. The helpers are the only variable.
//
// No direction is claimed (Codex-OpenCadre-8160 on 3983ecd): the CLI has no orderable version, so an old cached CLI
// sees newer helpers as different too. The line says "don't match" and names the HUB's current CLI as the fix, so
// following it can never downgrade an install.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
let dir: string;
let EMPTY_PATH: string;
let hub: Server;
let hubUrl: string;
// What the stand-in hub answers at /cli/manifest.json (Q1g): doctor prints the upgrade command from it, and prints NO URL
// when it cannot be verified. "ok" is a well-formed manifest; the others are the failure shapes F6 names.
let manifestMode: "ok" | "404" | "not-json" | "malformed" | "build" | "build-other-dialect" = "ok";
const SHA = "0123456789abcdef".repeat(4);
const STAMP = SHA.slice(0, 12);

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.toUpperCase() !== "PATH" && !k.startsWith("OPENCADRE_")) env[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, PATH: EMPTY_PATH, OPENCADRE_CONNECT_TIMEOUT_MS: "3000" } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out }));
  });
}
const doctor = (home: string) => run(["doctor", "--client", "codex", "--home", home]);
const binLines = (out: string) => out.split("\n").filter((l) => l.includes("~/.opencadre/bin"));

/** A fully wired Codex home pointed at the stand-in hub, with the helpers exactly as `connect` installs them. */
async function wiredHome(hubFor = () => hubUrl) {
  const home = mkdtempSync(path.join(dir, "home-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre-session]\ncommand = "node"\nargs = ["x"]\n`);
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: hubFor(), credential: `dev_${"0".repeat(48)}`, deviceId: "00000000-0000-0000-0000-000000000000" } }));
  const { HOOK_MARKERS } = await import("../cli/lib/session-hooks.mjs");
  const h = (script: string) => ({ type: "command", command: `node "C:${path.sep}bin${path.sep}${script}" --client codex`, timeout: 10 });
  writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [h(HOOK_MARKERS.awareness)] }],
    UserPromptSubmit: [{ hooks: [h(HOOK_MARKERS.awareness)] }],
    PostToolUse: [{ hooks: [h(HOOK_MARKERS.awareness), h(HOOK_MARKERS.gate)] }],
    Stop: [{ hooks: [h(HOOK_MARKERS.awareness), h(HOOK_MARKERS.usage)] }],
  } }));
  // Keep hook trust constant so this suite isolates helper drift. Codex records this only after the
  // user reviews the hooks; doctor reads its presence but leaves hash validation to Codex.
  const config = path.join(home, ".codex", "config.toml");
  const source = path.join(home, ".codex", "hooks.json").replaceAll("\\", "/");
  const slots = ["session_start:0:0", "user_prompt_submit:0:0", "post_tool_use:0:0", "post_tool_use:0:1", "stop:0:0", "stop:0:1"];
  writeFileSync(config, `${readFileSync(config, "utf8")}\n${slots.map((slot) => `[hooks.state.'${source}:${slot}']\ntrusted_hash = "sha256:test-record"`).join("\n\n")}\n`);
  const { installHelpers } = await import("../cli/lib/generations.mjs");
  installHelpers(path.join(home, ".opencadre", "bin"));
  return home;
}

/** Makes one installed helper differ from this CLI's copy the way an older (or newer) install does: the active
 * generation (cli/lib/generations.mjs) holds other bytes for it, installed and recorded as a whole, so it reads as a
 * different version, not as a local edit. */
async function makeHelperDiffer(home: string, name: string, text: string) {
  const { installHelpers, makeTarget } = await import("../cli/lib/generations.mjs");
  const { HELPERS, installedText } = await import("../cli/lib/helpers.mjs");
  const files = { ...Object.fromEntries(Object.keys(HELPERS).map((n) => [n, installedText(n)])), [name]: text };
  installHelpers(path.join(home, ".opencadre", "bin"), { target: makeTarget({ files }) });
}

let hubBuild: { helpers: Record<string, string>; imports: Record<string, string[]> };

beforeAll(async () => {
  const { cliBuild } = await import("../cli/lib/generations.mjs");
  hubBuild = cliBuild();
  dir = mkdtempSync(path.join(tmpdir(), "oc-doctor-helpers-"));
  EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-doctor-helpers-path-"));
  // Just enough hub for the session-server path: /v1/devices/me accepts the credential and honours the probe header.
  hub = createServer((req, res) => {
    if (req.url === "/v1/devices/me") {
      res.writeHead(200, { "content-type": "application/json", "x-opencadre-probe": "no-heartbeat" });
      return res.end(JSON.stringify({ name: "Test computer" }));
    }
    if (req.url === "/cli/manifest.json") {
      if (manifestMode === "404") return res.writeHead(404, { "content-type": "application/json" }).end("{}");
      if (manifestMode === "not-json") return res.writeHead(200, { "content-type": "text/html" }).end("<html>a captive portal</html>");
      // A stamp that is not the sha256's prefix: an answer that is JSON but does not describe one package.
      const stamp = manifestMode === "malformed" ? "ffffffffffff" : STAMP;
      const url = `https://public.example.test/cli/${stamp}/opencadre-cli.tgz`;
      // "build": the manifest also describes its build (PR-1's build.json), so doctor verifies the install against the
      // HUB. "build-other-dialect": the hub's build carries a different dialect, which the gate imports.
      const described = manifestMode.startsWith("build") ? {
        inputsDigest: "a".repeat(64),
        helpers: { ...hubBuild.helpers, ...(manifestMode === "build-other-dialect" ? { "opencadre-hook-dialect.mjs": "b".repeat(64) } : {}) },
        imports: hubBuild.imports,
      } : {};
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ schema: 1, ...described, tarball: { sha256: SHA, bytes: 1, stamp, url }, command: `npx -y ${url} connect --upgrade` }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
  const addr = hub.address();
  hubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => hub.close(() => r()));
  for (const d of [dir, EMPTY_PATH]) rmSync(d, { recursive: true, force: true });
});

describe("doctor checks the installed helpers against the CLI running it", () => {
  it("matching helpers: the best verdict (hook_trust_unverified, exit 3: Codex trust is recorded, not verified); one differing helper on the same home: helpers_mismatch and exit 1", async () => {
    const home = await wiredHome();

    const matching = await doctor(home);
    expect(binLines(matching.out).join("\n")).toMatch(/\[green\] Helpers in ~\/\.opencadre\/bin match the CLI running this check/);
    expect(matching.out).toMatch(/helpers=current/);
    // Since PR-B's follow-up a recorded Codex trust is amber, never green: this fully wired home's best verdict.
    expect(matching.out).toMatch(/verdict=hook_trust_unverified/);
    expect(matching.code).toBe(3);

    await makeHelperDiffer(home, "opencadre-mcp.mjs", "// a different opencadre-mcp.mjs\n");
    const differing = await doctor(home);
    const line = binLines(differing.out).find((l) => l.startsWith("[red]")) ?? "";
    expect(line).toMatch(/1 helper\(s\) in ~\/\.opencadre\/bin don't match the CLI running this check \(opencadre-mcp\.mjs\)/);
    // No direction claimed, and the fix is the hub's current CLI, never the copy that happens to be running.
    expect(line).not.toMatch(/outdated|older than this|newer than this/i);
    // The hub's STAMPED command, read from its manifest, with the host this computer is connected to (not the manifest's
    // public host): the bare URL npx has cached is never the advice (Q1g).
    expect(line).toContain(`npx -y ${hubUrl}/cli/${STAMP}/opencadre-cli.tgz connect --upgrade`);
    expect(line).not.toMatch(/\/cli\/opencadre-cli\.tgz/);
    expect(differing.out).toMatch(/helpers=mismatch/);
    expect(differing.out).toMatch(/verdict=helpers_mismatch/);
    expect(differing.out).not.toMatch(/verdict=healthy/);
    expect(differing.code).toBe(1);
  });

  it("an edited helper is named in amber and is not a fault on its own", async () => {
    const home = await wiredHome();
    appendFileSync(path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs"), "\n// a local edit\n");
    const r = await doctor(home);
    expect(binLines(r.out).join("\n")).toMatch(/\[amber\] Helper\(s\) in ~\/\.opencadre\/bin edited on this machine, left as they are \(opencadre-mcp\.mjs\)/);
    expect(r.out).toMatch(/helpers=edited/);
    expect(r.out).toMatch(/verdict=hook_trust_unverified/);
    expect(r.code).toBe(3);
  });

  it("an edited helper beside a differing one: both are reported, the mismatch decides the verdict", async () => {
    const home = await wiredHome();
    await makeHelperDiffer(home, "opencadre-awareness.mjs", "// a different awareness hook\n");
    appendFileSync(path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs"), "\n// a local edit\n");
    const r = await doctor(home);
    const lines = binLines(r.out).join("\n");
    expect(lines).toMatch(/\[red\] 1 helper\(s\) .* \(opencadre-awareness\.mjs\)/);
    expect(lines).toMatch(/\[amber\] Helper\(s\) .* edited on this machine, left as they are \(opencadre-mcp\.mjs\)/);
    expect(r.out).toMatch(/verdict=helpers_mismatch/);
    expect(r.code).toBe(1);
  });
});

// F6 (Q1g, ruling 049a §4): with the hub's CLI manifest unavailable, doctor prints NO package URL and says why. Each arm
// changes only what /cli/manifest.json answers (or whether the hub answers at all); the helper mismatch is the same, so the
// "ok" arm above is the control that the line CAN carry a command.
describe("doctor with the hub's CLI manifest unavailable", () => {
  const mismatchLine = async (home: string) => {
    await makeHelperDiffer(home, "opencadre-mcp.mjs", "// a different opencadre-mcp.mjs\n");
    const r = await doctor(home);
    return { r, line: binLines(r.out).find((l) => l.startsWith("[red]")) ?? "" };
  };
  for (const [mode, reason] of [["404", /HTTP 404/], ["not-json", /not JSON/], ["malformed", /not a CLI manifest/]] as const) {
    it(`manifest ${mode}: names the failure and prints no opencadre-cli.tgz URL`, async () => {
      manifestMode = mode;
      try {
        const { r, line } = await mismatchLine(await wiredHome());
        expect(line).toMatch(/1 helper\(s\) in ~\/\.opencadre\/bin don't match/);
        expect(line).toMatch(/CLI manifest .* could not be verified/);
        expect(line).toMatch(reason);
        expect(r.out).not.toMatch(/opencadre-cli\.tgz/);
        expect(r.out).toMatch(/verdict=helpers_mismatch/);
      } finally {
        manifestMode = "ok";
      }
    });
  }

  it("hub unreachable: names the failure and prints no opencadre-cli.tgz URL", async () => {
    // A port that was just listening and is now closed: connection refused, deterministically, with no network involved.
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const addr = dead.address();
    const deadUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const { r, line } = await mismatchLine(await wiredHome(() => deadUrl));
    expect(line).toMatch(/CLI manifest \(http:\/\/127\.0\.0\.1:\d+\/cli\/manifest\.json\) could not be verified \(unreachable/);
    expect(r.out).not.toMatch(/opencadre-cli\.tgz/);
  });
});

// Q1g PR-2 (plan §C): exactly one install state, the gate's whole closure compared file by file against the HUB's
// manifest when it describes its build, and a partial install is a fault.
describe("doctor: install state and the approval gate's closure", () => {
  it("a partial install (no generation pointer) is a red line and a fault", async () => {
    const home = await wiredHome();
    rmSync(path.join(home, ".opencadre", "bin", ".gen", "current"));
    const r = await doctor(home);
    expect(binLines(r.out).join("\n")).toMatch(/\[red\] The install in ~\/\.opencadre\/bin is partial \(the generation pointer .* is missing/);
    expect(r.out).toMatch(/helpers=partial/);
    expect(r.out).toMatch(/verdict=helpers_mismatch/);
    expect(r.code).toBe(1);
  });

  it("verified against the hub's build: the gate's closure matches, green; a different hub dialect is a red gate line", async () => {
    manifestMode = "build";
    try {
      const home = await wiredHome();
      const ok = await doctor(home);
      expect(ok.out).toMatch(/\[green\] Helpers in ~\/\.opencadre\/bin match the hub's CLI/);
      expect(ok.out).toMatch(/\[green\] The approval gate's \d+ files match the hub's CLI manifest/);
      expect(ok.code).toBe(3); // recorded Codex trust: amber hook_trust_unverified, the best a Codex home reaches
      manifestMode = "build-other-dialect";
      const off = await doctor(home);
      expect(off.out).toMatch(/\[red\] The approval gate's files don't match the hub's CLI .*opencadre-hook-dialect\.mjs is [0-9a-f]{12}, expected bbbbbbbbbbbb/);
      expect(off.out).toMatch(/helpers=mismatch/);
      expect(off.code).toBe(1);
    } finally {
      manifestMode = "ok";
    }
  });
});

it("a preserved custom gate is an actionable closure fault, never verified or healthy", async () => {
  manifestMode = "build";
  try {
    const home = await wiredHome();
    const bin = path.join(home, ".opencadre", "bin");
    writeFileSync(path.join(bin, "opencadre-approval-gate.mjs"), "process.exit(0);\n");
    const { applyInstall, planInstall } = await import("../cli/lib/generations.mjs");
    applyInstall(bin, planInstall(bin));
    const r = await doctor(home);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gate_closure=mismatch/);
    expect(r.out).toMatch(/verdict=helpers_mismatch/);
    expect(r.out).not.toMatch(/gate_closure=verified|verdict=healthy/);
    expect(r.out).toMatch(/opencadre-approval-gate\.mjs/);
  } finally { manifestMode = "ok"; }
}, 60_000);
