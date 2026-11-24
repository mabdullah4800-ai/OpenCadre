// The approval gate reads the current branch from the repository's files instead of starting `git rev-parse` (about
// 60 ms per git start on Windows), and runs `git remote get-url origin` once per run instead of twice. Neither may
// change a decision. Two kinds of proof:
//   1. The disk reader against git ITSELF as the oracle, in real repositories: wherever it answers, it answers what
//      `git rev-parse --abbrev-ref HEAD` prints; wherever it cannot be sure, it answers undefined (the gate then asks git).
//   2. The gate's whole output (exit code, stdout, stderr), byte for byte, with the disk reader in play and with it forced
//      off (GIT_DIR in the environment makes it defer to git, the path the gate always took before), for: a benign
//      command, a risky one that needs approval, a risky one in a worktree, a detached HEAD and a folder with no
//      repository. The spawn recorder shows the two arms really took different paths.
// No hub is contacted: the hub is a dead local port.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { headBranchOnDisk } from "../scripts/opencadre-config.mjs";
import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const GATE = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
const RECORDER = pathToFileURL(path.join(process.cwd(), "tests", "helpers", "record-spawn-options.mjs")).href;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString().trim();
/** What the gate's old path got: git's own answer, or null when git fails. */
const gitBranch = (cwd: string) => {
  try {
    return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    return null;
  }
};
const commit = (cwd: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
function repo(parent: string, name: string, branch: string, origin = true) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  if (origin) git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  commit(dir);
  return dir;
}

const root = mkdtempSync(path.join(tmpdir(), "gate-disk-branch-"));
const fx: Record<string, string> = {};
beforeAll(() => {
  fx.main = repo(root, "main", "main");
  fx.feature = repo(root, "feature", "feature-x");
  fx.worktree = path.join(root, "wt");
  git(fx.main, "worktree", "add", "-q", fx.worktree, "-b", "wt-branch");
  fx.detached = repo(root, "detached", "main");
  git(fx.detached, "checkout", "-q", "--detach");
  fx.sub = path.join(fx.main, "src", "deep");
  mkdirSync(fx.sub, { recursive: true });
  fx.packed = repo(root, "packed", "main");
  git(fx.packed, "branch", "feature-p");
  git(fx.packed, "checkout", "-q", "feature-p");
  git(fx.packed, "pack-refs", "--all");
  fx.noRepo = path.join(root, "no-repo");
  mkdirSync(fx.noRepo);
  // Doubt: each of these makes the reader defer to git.
  fx.unborn = path.join(root, "unborn");
  mkdirSync(fx.unborn);
  git(fx.unborn, "init", "-q", "-b", "feature-u");
  fx.tagged = repo(root, "tagged", "main");
  git(fx.tagged, "tag", "main");
  fx.tracked = repo(root, "tracked", "main");
  git(fx.tracked, "update-ref", "refs/remotes/main/HEAD", "HEAD");
  fx.emptyDotGit = path.join(fx.main, "vendored");
  mkdirSync(path.join(fx.emptyDotGit, ".git"), { recursive: true });
  fx.bare = path.join(root, "bare.git");
  git(root, "clone", "-q", "--bare", fx.main, fx.bare);
  fx.garbled = path.join(root, "garbled");
  mkdirSync(fx.garbled);
  writeFileSync(path.join(fx.garbled, ".git"), "this is not a gitdir line\n");
});

describe("headBranchOnDisk answers what git rev-parse --abbrev-ref HEAD prints, or defers", () => {
  it.each([
    ["a branch", "main", "main"],
    ["another branch", "feature", "feature-x"],
    ["a worktree (.git is a file naming its gitdir)", "worktree", "wt-branch"],
    ["a detached HEAD", "detached", "HEAD"],
    ["a subfolder of a checkout", "sub", "main"],
    ["a packed branch ref", "packed", "feature-p"],
  ])("%s: the same answer as git", (_label, name, expected) => {
    expect(gitBranch(fx[name])).toBe(expected);
    expect(headBranchOnDisk(fx[name])).toBe(expected);
  });

  it("no repository: null, as git fails there", () => {
    expect(gitBranch(fx.noRepo)).toBeNull();
    expect(headBranchOnDisk(fx.noRepo)).toBeNull();
  });

  it.each([
    ["an unborn branch (git fails)", "unborn", null],
    ["a tag with the branch's name (git prints heads/main)", "tagged", "heads/main"],
    ["a remote-tracking HEAD with the branch's name (git prints heads/main)", "tracked", "heads/main"],
    ["an empty .git folder, which git skips for the parent's", "emptyDotGit", "main"],
    ["a bare repository", "bare", "main"],
    ["a .git file that is not a gitdir line (git fails)", "garbled", null],
  ])("%s: undefined, so the gate asks git", (_label, name, git) => {
    expect(gitBranch(fx[name])).toBe(git);
    expect(headBranchOnDisk(fx[name])).toBeUndefined();
  });

  it("git environment overrides make it defer whatever the files say", () => {
    expect(headBranchOnDisk(fx.main, { GIT_DIR: path.join(fx.feature, ".git") })).toBeUndefined();
    expect(headBranchOnDisk(fx.main, {})).toBe("main");
  });
});

type Run = { code: number | null; out: string; err: string; git: string[] };
function gate(cwd: string, command: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const home = mkdtempSync(path.join(tmpdir(), "gate-disk-home-"));
  const record = path.join(home, "calls.jsonl");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", RECORDER, GATE, "--client", "claude-code"], {
      cwd,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, CLAUDE_CODE_SESSION_ID: "",
        OPENCADRE_URL: "http://127.0.0.1:9", OPENCADRE_KEY: "placeholder-not-a-key", OPENCADRE_GATE_MODE: "ask", OPENCADRE_GATE_CONFIG: "",
        OPENCADRE_APPROVAL_WAIT: "1", OPENCADRE_GATE_WARN: "", SPAWN_RECORD_FILE: record, ...extraEnv,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { file: string; args: string[] }) : [];
      resolve({ code, out, err, git: calls.filter((c) => c.file === "git").map((c) => c.args.join(" ")) });
    });
    child.stdin.end(JSON.stringify({ session_id: "disk-branch", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }));
  });
}

describe("the gate's output is byte-identical with the branch read from disk or from git", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const REV_PARSE = "rev-parse --abbrev-ref HEAD";
  // GIT_DIR makes the disk reader defer, so the gate asks git exactly as it did before; git itself reads the same repo.
  const viaGit = (dir: string) => ({ GIT_DIR: path.join(dir, ".git") });

  it.each([
    // [label, fixture, command, GIT_DIR for the git arm, does the disk arm skip git rev-parse?]
    ["benign: no git at all", "main", "echo hi", () => viaGit(fx.main), false],
    ["risky, approval needed, on main", "main", "git push --force origin main", () => viaGit(fx.main), true],
    ["risky in a worktree, naming main", "worktree", "git push --force origin main", () => ({ GIT_DIR: path.join(fx.main, ".git", "worktrees", "wt") }), true],
    ["risky in a worktree, exempt on its branch (git confirms)", "worktree", "git reset --hard", () => ({ GIT_DIR: path.join(fx.main, ".git", "worktrees", "wt") }), false],
    ["risky on a detached HEAD", "detached", "git reset --hard", () => viaGit(fx.detached), true],
    ["risky with no repository", "noRepo", "git reset --hard", () => viaGit(fx.noRepo), true],
  ] as const)("%s", async (_label, name, command, gitEnv, diskSkipsGit) => {
    const onDisk = await gate(fx[name], command);
    const viaGitRun = await gate(fx[name], command, gitEnv());
    expect({ code: onDisk.code, out: onDisk.out, err: onDisk.err }).toEqual({ code: viaGitRun.code, out: viaGitRun.out, err: viaGitRun.err });
    if (command === "echo hi") {
      expect(onDisk.git).toEqual([]);
      expect(viaGitRun.git).toEqual([]);
      return;
    }
    // The two arms took different routes to the same answer: the git arm always asked git for the branch.
    expect(viaGitRun.git).toContain(REV_PARSE);
    expect(onDisk.git.includes(REV_PARSE)).toBe(!diskSkipsGit);
    // One `git remote get-url origin` per run (it was two: hubMode skipped the memo).
    expect(onDisk.git.filter((c) => c === "remote get-url origin")).toHaveLength(1);
  });

  it("the risky case is a real hold, not a pass that both arms agree on trivially", async () => {
    const r = await gate(fx.main, "git push --force origin main");
    expect(r.out).toMatch(/"permissionDecision":\s*"deny"/);
  });
});
