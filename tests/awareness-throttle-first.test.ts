// The PostToolUse awareness hook checks its 60 s throttle BEFORE resolveHub, so the 59-of-60 calls that end silent
// anyway no longer read the client's MCP config, the credentials and the project list (about 9 ms each). The output is
// the same in both cases: silence when throttled, the hub lookup (and the digest, when there is one) when not.
// A read recorder shows which files the hook opened; the unthrottled run is the known positive that it can see the
// MCP config being read. No hub is contacted: the configured hub is a dead local port.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_HTTP } from "./fixtures/client-configs";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-awareness.mjs");
// Preload: append every path the hook reads with fs.readFileSync, then read it as asked.
const RECORD_READS = `data:text/javascript,${encodeURIComponent([
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const read = fs.readFileSync;",
  "fs.readFileSync = function (p, ...rest) { try { fs.appendFileSync(process.env.READ_RECORD_FILE, String(p) + '\\n'); } catch {} return read.call(this, p, ...rest); };",
  "syncBuiltinESMExports();",
].join("\n"))}`;

type Run = { code: number | null; out: string; reads: string[] };
function postToolUse(home: string, stateDir: string): Promise<Run> {
  const record = path.join(mkdtempSync(path.join(tmpdir(), "aw-reads-")), "reads.txt");
  return new Promise((resolve) => {
    // The default 60 s interval: the variable is removed, not emptied (an empty one reads as 0, never throttled).
    const { OPENCADRE_AWARENESS_MIN_INTERVAL: _interval, ...parent } = process.env;
    const child = spawn(process.execPath, ["--import", RECORD_READS, HOOK, "--client", "claude-code"], {
      env: {
        ...parent, CLAUDE_CODE_SESSION_ID: "", CLAUDE_CODE_HOST_SESSION_ID: "", OPENCADRE_URL: "", OPENCADRE_KEY: "",
        OPENCADRE_HOOK_HOME: home, HOME: home, USERPROFILE: home, OPENCADRE_AWARENESS_STATE_DIR: stateDir, READ_RECORD_FILE: record,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, reads: existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : [] }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "throttle-first", cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "echo hi" } }));
  });
}

/** A home connected the way `connect` writes ~/.claude.json (the captured HTTP entry), pointed at a dead local port. */
function connectedHome() {
  const home = mkdtempSync(path.join(tmpdir(), "aw-home-"));
  const entry = { ...CLAUDE_HTTP.mcpServers.opencadre, url: "http://127.0.0.1:9/mcp" };
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { opencadre: entry } }, null, 2));
  return home;
}
const readsConfig = (r: Run) => r.reads.some((p) => path.basename(p) === ".claude.json");

describe("PostToolUse awareness: the throttle is read before the hub lookup", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("unthrottled: looks the hub up (reads ~/.claude.json), stays silent on a dead hub, and starts the interval", async () => {
    const home = connectedHome();
    const stateDir = mkdtempSync(path.join(tmpdir(), "aw-state-"));
    const r = await postToolUse(home, stateDir);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "" });
    expect(readsConfig(r)).toBe(true);
    expect(existsSync(path.join(stateDir, "opencadre-awareness-throttle-first.json"))).toBe(true);
  });

  it("throttled: the same silence, without reading the client's config at all", async () => {
    const home = connectedHome();
    const stateDir = mkdtempSync(path.join(tmpdir(), "aw-state-"));
    await postToolUse(home, stateDir); // starts the interval
    const throttled = await postToolUse(home, stateDir);
    expect({ code: throttled.code, out: throttled.out }).toEqual({ code: 0, out: "" });
    expect(readsConfig(throttled)).toBe(false);
    // And the silence does not depend on what the lookup would have found: a home with no OpenCadre at all.
    const bare = mkdtempSync(path.join(tmpdir(), "aw-home-bare-"));
    const unconfigured = await postToolUse(bare, stateDir);
    expect({ code: unconfigured.code, out: unconfigured.out }).toEqual({ code: throttled.code, out: throttled.out });
  });
});
