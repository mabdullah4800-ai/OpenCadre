// The measurement probe (scripts/dev/hook-probe.mjs) is pasted into harness documents as evidence, so what it must
// never write matters as much as what it records.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers/tmp.js";

const PROBE = path.join(process.cwd(), "scripts", "dev", "hook-probe.mjs");

function probe(stdin: string, args: string[] = [], env: Record<string, string> = {}) {
  const log = path.join(tmpDir("oc-probe-"), "probe.jsonl");
  const r = spawnSync(process.execPath, [PROBE, ...args], { input: stdin, env: { PATH: process.env.PATH ?? "", OPENCADRE_PROBE_LOG: log, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, line: JSON.parse(readFileSync(log, "utf8").trim()) };
}

describe("the hook probe", () => {
  it("records the payload and the harness's own variables, and answers no opinion", () => {
    const r = probe(JSON.stringify({ hook_event_name: "preToolUse", tool_name: "MCP:opencadre_set_status" }), ["--tag", "t"], { CURSOR_VERSION: "2026.09.23" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("{}");
    expect(r.line.tag).toBe("t");
    expect(r.line.stdin.tool_name).toBe("MCP:opencadre_set_status");
    expect(r.line.env).toEqual({ CURSOR_VERSION: "2026.09.23" });
  });

  it("never writes a credential, a secret-named variable or an email address", () => {
    const r = probe(JSON.stringify({ user_email: "someone@example.com", k: "agt_abcdefghijkl", d: "dev_0123456789abcdef" }), [], {
      CURSOR_USER_EMAIL: "someone@example.com", CLAUDE_CODE_MESSAGING_TOKEN: "t0ps3cret",
    });
    const text = JSON.stringify(r.line);
    expect(text).not.toMatch(/someone@example\.com|abcdefghijkl|0123456789abcdef|t0ps3cret/);
    expect(r.line.env.CLAUDE_CODE_MESSAGING_TOKEN).toBe("[redacted]");
  });

  it("answers nothing when asked to (Claude Code, Codex, Gemini CLI), and survives non-JSON input", () => {
    const r = probe("not json", ["--answer", ""]);
    expect(r.out).toBe("");
    expect(r.line.stdin).toBe("not json");
  });
});
