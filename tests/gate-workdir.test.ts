// The branch exemption reads the branch where a command RUNS (review of 91c617a, S1). Kilo's bash tool takes a
// `workdir` and tells the model to use it instead of `cd`, so `git reset --hard` with workdir in another repository's
// `main` must not be exempt because the session's own project is on a feature branch.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const GATE = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");

const repo = (branch: string, parent = mkdtempSync(path.join(tmpdir(), "gate-wd-"))) => {
  const dir = path.join(parent, `repo-${branch}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
};

function gate(input: unknown, client = "kilo"): Promise<string> {
  const home = mkdtempSync(path.join(tmpdir(), "gate-wd-home-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, "--client", client], {
      env: { ...process.env, ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, OPENCADRE_URL: "", OPENCADRE_KEY: "", CLAUDE_CODE_SESSION_ID: "", OPENCADRE_GATE_MODE: "ask" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("a branch-aware rule reads the branch of the command's own folder", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const project = repo("feature");
  const other = repo("main");
  const body = (tool_input: object) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: project, tool_name: "Bash", tool_input });

  it("is exempt on the project's own feature branch", async () => {
    expect(await gate(body({ command: "git reset --hard" }))).toBe("");
    expect(await gate(body({ command: "git reset --hard", workdir: project }))).toBe("");
  });

  it("is NOT exempt when the command runs in another repository (on main), whatever the project's branch", async () => {
    const out = await gate(body({ command: "git reset --hard", workdir: other }));
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("is NOT exempt in a folder outside the project, even one on a feature branch", async () => {
    const outside = repo("topic");
    const out = await gate(body({ command: "git reset --hard", workdir: outside }));
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// Crush's bash names the folder `working_dir` (review of e6c51ae, B1).
describe("Crush's `working_dir` is read the same way", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const project = repo("feature");
  const other = repo("main");
  const body = (tool_input: object) => ({ event: "PreToolUse", session_id: "s", cwd: project, tool_name: "bash", tool_input: { description: "x", ...tool_input } });

  it("is exempt in the session's own feature branch, and NOT in another repository on main", async () => {
    expect(await gate(body({ command: "git reset --hard" }), "crush")).toBe("");
    expect(JSON.parse(await gate(body({ command: "git reset --hard", working_dir: other }), "crush")).decision).toBe("deny");
  });
});
