// The approval gate on Windows: PowerShell and cmd.exe's own destructive commands are held, and ordinary
// PowerShell is NOT flagged.
//
// WHY: the default rules were POSIX. On a Windows machine running Codex (which runs PowerShell) the gate
// matched `rm -rf` and nothing native, so `Remove-Item -Recurse -Force` ran ungated. That was blocking
// review of the Clearance cell (#530, Codex-OpenCadre-d193). In the other direction, the POSIX reading of
// "dynamic" flagged every `$x = …` assignment: MEASURED 2026-09-22, at least 42 of 50 `approval.noted`
// events in one hour were harmless PowerShell.
//
// notify mode throughout, as in approval-hook.test.ts: a positive case is "recorded as noted with exactly
// this category" and a negative case is "nothing recorded at all". Every positive has a negative beside it
// that differs in one respect, so a rule that fires on everything fails here as surely as one that fires
// on nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { listApprovals } from "../src/approvals.js";
import { GATE_TEST_ENV, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn.js";

const HOOK = path.join(process.cwd(), "examples", "hooks", "opencadre-approval-gate.mjs");
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function runGate(command: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gate-ps-"));
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...GATE_TEST_ENV, HOME: cwd, USERPROFILE: cwd, OPENCADRE_GATE_MODE: "", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));
  });
}

async function noted(command: string, shell: "powershell" | "posix") {
  const { orgId } = createOrganization(`PS gate ${shell} ${command}`);
  const agent = registerAgent(orgId, "Codex Coder");
  await runGate(command, { OPENCADRE_URL: baseUrl, OPENCADRE_KEY: agent.apiKey, OPENCADRE_GATE_MODE: "notify", OPENCADRE_GATE_SHELL: shell });
  return listApprovals(orgId, { status: "noted" }).map((a) => a.category);
}

describe("PowerShell and cmd.exe destruction is held (PowerShell shell)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const cases: Array<[command: string, categories: string[]]> = [
    // Remove-Item under its names, with -Recurse spelled out, abbreviated, and in different positions.
    ["Remove-Item -Recurse -Force C:\\work\\old", ["ps-recursive-delete"]],
    ["Remove-Item C:\\work\\old -Recurse", ["ps-recursive-delete"]],
    ["ri -r -fo ./old", ["ps-recursive-delete"]],
    ["rm -Recurse -Force ./old", ["ps-recursive-delete"]],
    ["rm -r -fo ./old", ["ps-recursive-delete"]],
    ["del -rec .\\old", ["ps-recursive-delete"]],
    ["erase -Recurse:$true .\\old", ["ps-recursive-delete"]],
    ["REMOVE-ITEM -RECURSE .\\old", ["ps-recursive-delete"]],
    // Hidden inside a pipeline, a script block, and a nested shell.
    ["Get-ChildItem .\\old | Remove-Item -Recurse -Force", ["ps-recursive-delete"]],
    ["Get-ChildItem | ForEach-Object { Remove-Item $_ -Recurse }", ["ps-recursive-delete"]],
    ["powershell -Command \"Remove-Item -Recurse -Force .\\old\"", ["ps-recursive-delete"]],
    ["& 'C:\\Windows\\System32\\cmd.exe' /c \"rd /s /q C:\\work\\old\"", ["cmd-tree-delete"]],
    // cmd.exe's own deletes.
    ["cmd /c rd /s /q C:\\work\\old", ["cmd-tree-delete"]],
    ["rmdir /s old", ["cmd-tree-delete"]],
    ["del /f /q C:\\work\\old\\*", ["cmd-tree-delete"]],
    ["del /s *.log", ["cmd-tree-delete"]],
    // Disks.
    ["Format-Volume -DriveLetter D", ["disk-destroy"]],
    ["Clear-Disk -Number 1 -RemoveData", ["disk-destroy"]],
    // POSIX rm -rf still counts (it can reach bash through `bash -c`).
    ["& 'C:/Program Files/Git/bin/bash.exe' -c 'rm -rf /c/work/old'", ["rm-rf"]],
    // The right-hand side of an assignment is a command (Codex-OpenCadre-d193, #534).
    ["$removed = Remove-Item -Recurse -Force C:\\work\\old -PassThru", ["ps-recursive-delete"]],
    ["$r=Remove-Item -Recurse .\\old", ["ps-recursive-delete"]],
    ["[array]$r = Remove-Item -Recurse .\\old", ["ps-recursive-delete"]],
    ["$a = $b = ri -r .\\old", ["ps-recursive-delete"]],
    ["$vol = Format-Volume -DriveLetter D", ["disk-destroy"]],
    ["$d += Clear-Disk -Number 1 -RemoveData", ["disk-destroy"]],
    ["powershell -Command '$removed = Remove-Item -Recurse -Force .\\old'", ["ps-recursive-delete"]],
    // A comment next to a real delete does not hide it.
    ["<# cleanup #> Remove-Item -Recurse .\\old", ["ps-recursive-delete"]],
    ["Remove-Item -Recurse .\\old # cleanup", ["ps-recursive-delete"]],
    ["# cleanup first\nRemove-Item -Recurse .\\old", ["ps-recursive-delete"]],
    ["Remove-Item -Recurse '.\\old#1'", ["ps-recursive-delete"]],
    ["Get-Date; rm -rf C:\\work\\old # cleanup", ["rm-rf"]],
  ];
  it.each(cases)("holds %s", async (command, categories) => {
    expect(await noted(command, "powershell")).toEqual(categories);
  });
});

describe("the same shapes WITHOUT the destructive part pass (PowerShell shell)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const harmless = [
    "Remove-Item C:\\work\\old\\file.txt",        // one file, no -Recurse
    "Remove-Item .\\old -Recurse:$false",          // recursion explicitly off
    "Remove-Item .\\old -Force",                   // -Force alone is not recursive
    "rd emptydir",                                  // cmd rd without /s
    "del file.txt",                                 // one file, no /s or /f
    "Get-Volume",                                   // reading disks, not destroying them
    "Remove-Item -Recurse -Force node_modules",    // routine build output: the default allowlist
    "rd /s /q dist",                                // routine build output, cmd form
    // An assignment whose right-hand side only reads (-Recurse on Get-ChildItem is not a delete).
    "$x = Get-ChildItem C:\\work\\old -Recurse",
    "$files = Get-ChildItem -Recurse | Select-Object -First 5",
    "$env:FOO='bar'; Get-Date",
    // A comment that only MENTIONS a delete or a disk command.
    "Get-ChildItem <# Remove-Item -Recurse .\\old #>",
    "Get-ChildItem # then Remove-Item -Recurse .\\old",
    // ...including one whose comment holds a statement separator (the old split read past it).
    "Get-Date # ; Remove-Item -Recurse .\\old",
    "Get-Date <# a; Remove-Item -Recurse .\\old #>",
    "Get-Date <# a | Format-Volume -DriveLetter D #>",
    // ...and one that mentions a POSIX rm -rf, which the POSIX rules read (Codex-OpenCadre-d193, #534).
    "Get-Date # rm -rf C:\\work\\old",
    "Get-Date <# rm -rf C:\\work\\old #>",
    "<# then: git push --force #>\nGet-Date",
    "<# Format-Volume -DriveLetter D #>\nGet-Volume",
  ];
  it.each(harmless)("passes %s", async (command) => {
    expect(await noted(command, "powershell")).toEqual([]);
  });
});

describe("ordinary PowerShell is not 'dynamic' (the over-fire, fixed)", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  // These are shapes a Codex chat actually ran on 2026-09-22 (timeline #29834-#29842), and each was
  // noted as `unresolved-dynamic-command`. None of them invokes a computed program.
  const ordinary = [
    "$lines = @(gh api 'repos/openai/codex/contents/x.rs?ref=v1' -H 'Accept: application/vnd.github.raw')",
    "$lines = @(gh api 'x'); for($i=0;$i -lt $lines.Count;$i++){ if($lines[$i] -match 'y'){ '{0}: {1}' -f ($i+1),$lines[$i] } }",
    "Write-Host \"line one`nline two\"",
    "$env:FOO = 'bar'; node script.mjs",
    "<# & $cmd #> Get-Date",                           // a comment that only mentions a computed call
    "Get-Date # . $script",
    "Get-Date # ; & $cmd",
    "Get-Date <# ; iex $payload #>",
    "Start-Process -FilePath notepad.exe -ArgumentList $file",
    "Start-Process notepad -ArgumentList $args -Wait",
    "Start-Process -Wait -FilePath:notepad.exe",
  ];
  it.each(ordinary)("does not flag %s", async (command) => {
    expect(await noted(command, "powershell")).toEqual([]);
  });

  // ...while a program that really cannot be known ahead of time still is.
  const dynamic = [
    "& $cmd --force",
    "& (Get-Command $name) -x",
    ". $script",
    "iex $payload",
    "Invoke-Expression (Get-Content .\\run.txt -Raw)",
    "Start-Process $exe -ArgumentList '/q'",
    "Get-ChildItem | ForEach-Object { & $_.FullName }",
    // Start-Process's program is its -FilePath, not its first argument (Codex-OpenCadre-d193, #534).
    "Start-Process -FilePath $exe",
    "Start-Process -FilePath:$exe -Wait",
    "Start-Process -Wait -NoNewWindow -FilePath $exe",
    "Start-Process -WindowStyle Hidden $exe",
    "Start-Process -f (Get-Command $name).Source",
    "$p = Start-Process -FilePath $exe -PassThru",
    "$x = & $cmd",
  ];
  it.each(dynamic)("still flags %s", async (command) => {
    expect(await noted(command, "powershell")).toEqual(["unresolved-dynamic-command"]);
  });
});

describe("the POSIX shell keeps its own reading", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("still flags a POSIX command whose program is a variable", async () => {
    expect(await noted("$CMD --force", "posix")).toEqual(["unresolved-dynamic-command"]);
  });
  it("still holds rm -rf", async () => {
    expect(await noted("rm -rf /tmp/old", "posix")).toEqual(["rm-rf"]);
  });
  it("catches a Windows-native recursive delete handed to PowerShell from a POSIX shell", async () => {
    expect(await noted("pwsh -c \"Remove-Item -Recurse -Force ./old\"", "posix")).toEqual(["ps-recursive-delete"]);
  });
});

describe("Copilot's typed PowerShell shell", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  const runCopilot = (toolName: string, toolArgs: object) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const home = mkdtempSync(path.join(tmpdir(), "gate-copilot-ps-"));
    const child = spawn(process.execPath, [HOOK, "--client", "copilot"], { env: { ...process.env, ...GATE_TEST_ENV, HOME: home, USERPROFILE: home, OPENCADRE_URL: "", OPENCADRE_KEY: "", OPENCADRE_GATE_MODE: "strict" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ sessionId: "cop-ps", cwd: home, toolName, toolArgs }));
  });

  it("holds a dynamic command sent through write_powershell just like powershell", async () => {
    const direct = await runCopilot("powershell", { command: ". $script" });
    const typed = await runCopilot("write_powershell", { shellId: "ps1", input: ". $script" });
    expect(direct.code).toBe(0);
    expect(typed.code).toBe(0);
    expect(JSON.parse(direct.out).permissionDecision).toBe("deny");
    expect(JSON.parse(typed.out).permissionDecision).toBe("deny");
  });
});
