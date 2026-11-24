import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ChatGPT/Codex desktop app: `opencadre connect --client codex` installs the inbox skill and the
// scheduled-task setup message; `opencadre doctor --client codex` checks the loop without changing anything.
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
// These tests assert the exact command text, so pin "no built CLI package": whether dist/cli exists on this checkout
// must not change the result (tests/cli-url-stamp.test.ts covers the ?v= stamp itself).
process.env.OPENCADRE_CLI_TARBALL = "__no_cli_package_in_this_test__.tgz";
const { app } = await import("../src/rest.js");
const { createOrganization, registerAgent } = await import("../src/service.js");
const { db } = await import("../src/db.js");
const { planInboxSkill, copyToClipboardHint } = await import("../cli/lib/codex-app.mjs");

const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");
const EMPTY_PATH = mkdtempSync(path.join(tmpdir(), "oc-codexapp-path-"));

let server: http.Server;
let hub: string;
let operatorKey: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  hub = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const { orgId } = createOrganization("Codex App Org");
  operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let nameCounter = 0;
async function newCode() {
  const agentName = `Codex-App-${++nameCounter}`;
  const res = await fetch(`${hub}/v1/connect-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify({ agentName, client: "codex" }),
  });
  return { code: (await res.json()).code as string, agentName };
}

/** Async spawn: the hub runs in this process. PATH is empty so no real client CLI is touched. */
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

const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-codexapp-home-"));
const connect = (home: string, code: string, ...extra: string[]) => run(["connect", "--hub", hub, "--code", code, "--home", home, "--client", "codex", ...extra]);
const doctor = (home: string) => run(["doctor", "--client", "codex", "--home", home]);
const skillFile = (home: string) => path.join(home, ".codex", "skills", "opencadre-inbox", "SKILL.md");
const setupFile = (home: string) => path.join(home, ".opencadre", "codex-inbox-setup.txt");
const keyIn = (text: string) => text.match(/agt_[0-9a-f]{48}/)?.[0] ?? "";
const configKey = (home: string) => keyIn(readFileSync(path.join(home, ".codex", "config.toml"), "utf8"));
// Doctor observes Codex's trust record; the test never tries to reproduce Codex's hash algorithm.
function recordTestHookTrust(home: string) {
  const config = path.join(home, ".codex", "config.toml");
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const source = hooksFile.replaceAll("\\", "/");
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8")).hooks;
  const tables = Object.entries(hooks).flatMap(([event, groups]) =>
    (groups as Array<{ hooks: Array<{ command: string }> }>).flatMap((group, groupIndex) =>
      group.hooks.flatMap((handler, handlerIndex) =>
        handler.command.includes("opencadre-")
          ? [`[hooks.state.'${source}:${event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}:${groupIndex}:${handlerIndex}']\ntrusted_hash = "sha256:test-record"\n`]
          : [])));
  writeFileSync(config, `${readFileSync(config, "utf8")}\n${tables.join("\n")}`);
}
const TEMPLATE_SETUP = readFileSync(path.join(process.cwd(), "cli", "templates", "codex-inbox-setup.txt"), "utf8").trim();

async function connected() {
  const home = tempHome();
  mkdirSync(path.join(home, ".codex"));
  const { code, agentName } = await newCode();
  const r = await connect(home, code, "--verbose"); // --verbose: these tests read the file list
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return { home, agentName, key: configKey(home), r };
}

const setHeartbeat = (name: string, sqlAgo: string | null) =>
  db.prepare(`UPDATE agents SET last_heartbeat_at = ${sqlAgo === null ? "NULL" : "datetime('now', ?)"} WHERE name = ?`)
    .run(...(sqlAgo === null ? [name] : [sqlAgo, name]));
const heartbeatOf = (name: string) => (db.prepare(`SELECT last_heartbeat_at FROM agents WHERE name = ?`).get(name) as { last_heartbeat_at: string | null }).last_heartbeat_at;

describe("opencadre connect --client codex: ChatGPT desktop app setup", () => {
  it("installs the inbox skill with the per-run routine and no stop condition", async () => {
    const { home, agentName, key, r } = await connected();
    const skill = readFileSync(skillFile(home), "utf8");
    expect(skill).toMatch(/^---\nname: opencadre-inbox\ndescription: .+\n---\n/);
    expect(skill).toContain(`You are ${agentName}`);
    expect(skill).not.toContain("{{");
    for (const phrase of ["`wait_for_message`", "`timeoutSeconds` 55", "`reply`", "`get_messages`", "`set_status`", "this same chat", "after every step", "up to 10 times in a row", "a failed wait counts as one of the 10","Never put API keys", "Never cancel or pause this scheduled task", "Keep replies short"]) {
      expect(skill).toContain(phrase);
    }
    expect(skill).toContain("Never include internal session logs, token or telemetry records, internal thread/session IDs, or local session file paths in OpenCadre messages; summarize in plain words instead");
    expect(skill).toMatch(/coarse redacted status/);
    expect(skill).not.toMatch(/\bstop\b|\buntil\b|\bexit\b|when done/i);
    expect(skill).not.toContain(key);
    expect(r.out).toContain(skillFile(home));
  }, 30_000);

  it("writes and prints the paste-ready scheduled-task message, and puts new chat in the next steps", async () => {
    const { home, key, r } = await connected();
    const setup = readFileSync(setupFile(home), "utf8");
    expect(setup.trim()).toBe(TEMPLATE_SETUP);
    expect(setup).toContain("FREQ=MINUTELY;INTERVAL=1");
    expect(setup).toContain("$opencadre-inbox");
    expect(setup).toMatch(/failed runs only/);
    // An in-chat scheduled task inherits the chat's model, so the model is picked in the chat, not the task.
    expect(setup).not.toMatch(/model/i);
    expect(r.out).toContain(TEMPLATE_SETUP);
    expect(r.out).toContain(setupFile(home));
    const next = r.out.slice(r.out.indexOf("Next steps:"));
    expect(next).toMatch(/1\) .*new chat/i);
    expect(next).toMatch(/2\) .*ONE new chat.*model you want doing the work FIRST.*paste/i);
    expect(next).toMatch(/3\) .*computer on/i);
    expect(next).toMatch(/4\) .*one chat for everything/i);
    expect(next).toMatch(/1\) .*Settings > Hooks.*trust.*OpenCadre/i);
    // Measured on the 0.157.1 app (HARNESS-CODEX §10.7): Settings > Hooks lists a folder's hooks only after a chat
    // has run there, so the first message comes BEFORE the trust step, in that order.
    expect(next).toMatch(/1\) .*send one ordinary message.*then open Settings > Hooks/i);
    expect(next).toMatch(/5\) .*doctor --client codex/);
    // #368 ask 1: the message was already written to a file and the path already printed, so the
    // one-action gap was never storage -- it was that nothing said HOW to get the file onto the
    // clipboard. Asserted per platform, and asserted ABSENT on Linux, because naming the wrong
    // tool there (wl-copy vs xclip vs xsel, session-dependent) is worse than naming none: the path
    // is still printed either way, so nothing is lost by staying quiet.
    if (process.platform === "darwin") expect(next).toContain(`pbcopy < "${setupFile(home)}"`);
    else if (process.platform === "win32") expect(next).toContain(`type "${setupFile(home)}" | clip`);
    else expect(next).not.toMatch(/Copy it in one step/);
    // The end-to-end assertion above can only exercise the branch for the platform the suite runs
    // on, so the other two are covered directly below rather than left to whoever runs CI.
    expect(r.out).toMatch(/hooks\.json.*Codex app and CLI; review in Settings > Hooks before use/);
    expect(r.out).toContain("opencadre-cli.tgz doctor --client codex");
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);
    expect(setup).not.toContain(key);
    expect(r.out + r.err).not.toContain(key);
  }, 30_000);

  it("is idempotent: the same agent leaves the skill unchanged, a different one keeps a .bak", async () => {
    const home = tempHome();
    const first = planInboxSkill({ home, agentName: "Codex-Same" });
    mkdirSync(path.dirname(first.file), { recursive: true });
    writeFileSync(first.file, first.after);
    expect(planInboxSkill({ home, agentName: "Codex-Same" }).after).toBe(readFileSync(first.file, "utf8"));
    expect(planInboxSkill({ home, agentName: "Codex-Same" }).before).toBe(first.after);

    const { code } = await newCode();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    expect((await connect(home, code)).code).toBe(0);
    const dir = path.dirname(skillFile(home));
    expect(readdirSync(dir).filter((f) => f.startsWith("SKILL.md.bak-"))).toHaveLength(1);
    const again = await newCode();
    const before = readFileSync(skillFile(home), "utf8");
    // Re-running for another agent rewrites it once more; the setup file stays byte-identical.
    const setupBefore = readFileSync(setupFile(home), "utf8");
    expect((await connect(home, again.code, "--replace")).code).toBe(0);
    expect(readFileSync(skillFile(home), "utf8")).not.toBe(before);
    expect(readFileSync(setupFile(home), "utf8")).toBe(setupBefore);
    expect(readdirSync(path.join(home, ".opencadre")).filter((f) => f.includes(".bak-"))).toEqual([]);
  }, 30_000);

  it("--dry-run lists the skill and setup file without writing them", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const { code } = await newCode();
    const r = await run(["connect", "--hub", hub, "--code", code, "--home", home, "--client", "codex", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(skillFile(home));
    expect(r.out).toContain(setupFile(home));
    expect(existsSync(skillFile(home))).toBe(false);
  }, 30_000);
});

describe("opencadre doctor --client codex", () => {
  it("requires hook trust before reporting a healthy loop, in a redacted format", async () => {
    const { home, agentName, key } = await connected();
    const me = await (await fetch(`${hub}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).json();
    const pending = await doctor(home);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain("verdict=hooks_untrusted");
    expect(pending.out).toContain("Settings > Hooks");
    expect(pending.out).toMatch(/send one ordinary message.*then open Settings > Hooks/);
    recordTestHookTrust(home);
    const d = await doctor(home);
    expect(d.err).toBe("");
    // #692 follow-up: recorded Codex trust is not verified trust, so the best verdict is amber (exit 3), never healthy.
    expect(d.code).toBe(3);
    expect(d.out).toMatch(/\[green\].*mcp_servers\.opencadre.*key present: yes/);
    expect(d.out).toMatch(/\[green\].*skill/i);
    expect(d.out).toMatch(new RegExp(`\\[green\\].*${agentName}`));
    expect(d.out).toMatch(/\[green\].*heartbeat/i);
    expect(d.out).toMatch(/\[green\].*Session hooks installed/i);
    expect(d.out).toMatch(/\[amber\] Codex has recorded hook trust for this hooks\.json[^\n]*recorded, current validity unverified/);
    expect(d.out).not.toContain("Inbox loop healthy");
    expect(d.out).toContain(`inbox_skill=installed mcp=configured key=present hooks=present hub_identity=${agentName} heartbeat=fresh(<3m) verdict=hook_trust_unverified hook_trust=recorded`);
    expect(d.out).not.toContain(key);
    expect(d.out).not.toContain(me.agentId);
    expect(d.out).not.toContain(me.orgId);
    expect(d.out).not.toContain(home);
  }, 30_000);

  it("is amber when the heartbeat is minutes old, red when it is hours old or missing, and never refreshes it", async () => {
    const { home, agentName, key } = await connected();
    recordTestHookTrust(home);
    setHeartbeat(agentName, "-10 minutes");
    const beat = heartbeatOf(agentName);
    const amber = await doctor(home);
    expect(amber.code).toBe(1);
    expect(amber.out).toMatch(/\[amber\].*heartbeat.*10 min/i);
    expect(amber.out).toContain("No recent activity: check the scheduled task is Active in ChatGPT → Scheduled and the OpenCadre chat isn't stuck in a long turn");
    expect(amber.out).toContain("heartbeat=stale verdict=check_scheduled_task");
    // Doctor's own calls must not count as the loop being alive.
    expect(heartbeatOf(agentName)).toBe(beat);

    setHeartbeat(agentName, "-3 hours");
    const red = await doctor(home);
    expect(red.out).toMatch(/\[red\].*heartbeat/i);
    expect(red.out).toContain("verdict=check_scheduled_task");

    setHeartbeat(agentName, null);
    const none = await doctor(home);
    expect(none.out).toMatch(/\[red\].*heartbeat/i);
    expect(none.out).toContain("heartbeat=none");
    for (const r of [amber, red, none]) expect(r.out + r.err).not.toContain(key);
  }, 30_000);

  it("is red when config.toml has no opencadre server, and changes nothing", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const d = await doctor(home);
    expect(d.code).toBe(1);
    expect(d.out).toMatch(/\[red\].*mcp_servers\.opencadre/);
    expect(d.out).toMatch(/\[red\].*skill/i);
    expect(d.out).toContain("mcp=missing");
    expect(d.out).toContain("verdict=not_connected");
    expect(readdirSync(path.join(home, ".codex"))).toEqual([]);
    expect(existsSync(path.join(home, ".opencadre"))).toBe(false);
  }, 30_000);

  // The DEVICE path -- the one the sprint's self-serve flow uses -- writes
  // [mcp_servers.opencadre-session], NOT the named-agent table. doctor looked only for the latter,
  // so a computer that had just connected successfully was reported not_connected: two red lines
  // and exit 1. Measured 2026-09-18 at main 05638d8, and it is the last step of the 5-minute path
  // -- connect itself prints `Check the loop any time: npx … doctor --client codex`.
  //
  // A session entry carries no key and no url ON PURPOSE: the credential lives in
  // credentials.json and the proxy resolves the hub itself. Neither absence is a fault, so this
  // test pins that neither is reported as one.
  it("is healthy after device hook trust and warns honestly when the hub has no build manifest", async () => {
    const home = tempHome();
    const res = await fetch(`${hub}/v1/org/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Doctor Machine", client: "codex" }),
    });
    const { code } = (await res.json()) as { code: string };
    const c = await run(["connect", "--hub", hub, "--code", code, "--home", home, "--client", "codex"]);
    expect(c.err).toBe("");
    expect(c.code).toBe(0);
    // Pin the table the device path actually writes, so this test fails loudly if its name changes.
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.opencadre-session]");
    // And pin the HOOKS this path writes. It set up the MCP table and stopped there, so a Codex chat
    // got the tools with no awareness injection, no usage reporting and no gate -- HARNESS-CODEX.md
    // §9 item 4, "install hooks.json on a computer-credential connect". Asserted on the FILE, so a
    // regression fails here by name rather than only as a red line further down.
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).toContain("opencadre-awareness.mjs");

    const pending = await doctor(home);
    expect(pending.out).toContain("verdict=hooks_untrusted");
    expect(pending.code).toBe(1);
    recordTestHookTrust(home);
    const d = await doctor(home);
    expect(d.out).toMatch(/\[green\].*mcp_servers\.opencadre-session/);
    expect(d.out).toContain("session server; credential in credentials.json");
    expect(d.out).toContain("key=session");
    // #692 follow-up: recorded Codex trust is amber (hook_trust_unverified, exit 3), never healthy.
    expect(d.out).toContain("verdict=hook_trust_unverified");
    expect(d.code).toBe(3);
    // This fixture deliberately has no built CLI package, so the gate can match the local CLI but cannot claim
    // verification against the hub (503). Require exactly these two ambers: any extra amber or any red still fails.
    expect(d.out).not.toMatch(/\[red\]/);
    expect(d.out.split(/\r?\n/).filter((line) => line.startsWith("[amber]"))).toEqual([
      expect.stringMatching(/^\[amber\] Codex has recorded hook trust for this hooks\.json in ~\/\.codex\/config\.toml: recorded, current validity unverified/),
      expect.stringMatching(/^\[amber\] The approval gate's \d+ files match the CLI running this check, but could not be checked against the hub's manifest \(HTTP 503\)$/),
    ]);
    expect(d.out).toContain("gate_closure=matches-cli");
    expect(d.out).not.toContain("url missing");

    // The credential is read to probe the hub and must never reach the report.
    const { credential } = (JSON.parse(readFileSync(path.join(home, ".opencadre", "credentials.json"), "utf8")) as { computer: { credential: string } }).computer;
    expect(credential).toMatch(/^dev_/);
    expect(d.out + d.err).not.toContain(credential);
    expect(d.out).not.toContain(home);
  }, 30_000);

  it("is red when the hub rejects the configured key, without printing it", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, ".codex"));
    const fake = `agt_${"0".repeat(48)}`;
    writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.opencadre]\nurl = "${hub}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${fake}" }\n`);
    const d = await doctor(home);
    expect(d.code).toBe(1);
    expect(d.out).toMatch(/\[red\].*(rejected|401)/i);
    expect(d.out).toContain("hub_identity=rejected");
    expect(d.out + d.err).not.toContain(fake);
  }, 30_000);
});

describe("GET with x-opencadre-probe: no-heartbeat", () => {
  it("reads without refreshing liveness and says so; other requests still heartbeat", async () => {
    const { agentName, key } = await connected();
    setHeartbeat(agentName, "-10 minutes");
    const beat = heartbeatOf(agentName);
    const probe = await fetch(`${hub}/v1/agents`, { headers: { authorization: `Bearer ${key}`, "x-opencadre-probe": "no-heartbeat" } });
    expect(probe.status).toBe(200);
    expect(probe.headers.get("x-opencadre-probe")).toBe("no-heartbeat");
    expect(heartbeatOf(agentName)).toBe(beat);
    const post = await fetch(`${hub}/v1/status`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-opencadre-probe": "no-heartbeat", "content-type": "application/json" }, body: JSON.stringify({ task: "x" }) });
    expect(post.status).toBe(200);
    expect(heartbeatOf(agentName)).not.toBe(beat);
  }, 30_000);

  // #585 (Codex-OpenCadre-8160): the OpenCode mail watcher long-polls a chat's inbox for as long as OpenCode runs. The
  // wait beats on its own (once on entry, then every minute of the hold), so the header must reach the hold too, or an
  // abandoned chat reads as online forever. The second arm is the control: the same wait without the header beats.
  it("a long-poll wait with the header does not keep the agent online; the same wait without it does", async () => {
    const { agentName, key } = await connected();
    setHeartbeat(agentName, "-10 minutes");
    const beat = heartbeatOf(agentName);
    const probed = await fetch(`${hub}/v1/messages/wait?peek=true&timeoutSeconds=1`, { headers: { authorization: `Bearer ${key}`, "x-opencadre-probe": "no-heartbeat" } });
    expect(probed.status).toBe(200);
    expect(heartbeatOf(agentName)).toBe(beat);
    const plain = await fetch(`${hub}/v1/messages/wait?peek=true&timeoutSeconds=1`, { headers: { authorization: `Bearer ${key}` } });
    expect(plain.status).toBe(200);
    expect(heartbeatOf(agentName)).not.toBe(beat);
  }, 30_000);
});

// #368: every branch of the clipboard hint, on one machine. The per-platform behaviour is the whole
// point of the helper, and testing only the branch this runner happens to take is exactly how #305
// shipped -- a fixture correct on Windows and wrong everywhere else, green for months.
describe("copyToClipboardHint", () => {
  it("names the platform's own one-liner on macOS and Windows", () => {
    expect(copyToClipboardHint("/tmp/setup.md", "darwin")).toBe('pbcopy < "/tmp/setup.md"');
    expect(copyToClipboardHint("C:\\x\\setup.md", "win32")).toBe('type "C:\\x\\setup.md" | clip');
  });

  // Review of #411 (reviewer 1051), measured on both shells: unquoted, `type C:\Users\John
  // Smith\... | clip` reports "The system cannot find the file specified" and leaves the clipboard
  // empty, and `pbcopy < /Users/john smith/...` redirects from `/Users/john`. `file` always carries
  // the user's home directory, so a space in it is common on Windows and not rare on macOS -- and
  // the failure mode is the worst kind, since the line PROMISES to be the one-step copy while doing
  // nothing. The two assertions above could not catch it: both fixtures are space-free, and both
  // pin the helper's own output format, so they fail when the string changes rather than when the
  // command breaks.
  it("emits a command the shell still reads as one path when the home directory has a space", () => {
    const spaced = path.join(mkdtempSync(path.join(tmpdir(), "oc-codexapp-spaced-")), "John Smith");
    mkdirSync(spaced, { recursive: true });
    const file = path.join(spaced, "codex-inbox-setup.txt");
    const contents = "PASTE-ME-CONTENT";
    writeFileSync(file, contents);

    // Run the emitted command through the real shell, with the clipboard sink swapped for one that
    // prints: the clipboard is not readable in CI, but the failure is in the SHELL's word-splitting
    // of the path, which is upstream of the sink and is what this reproduces. Asserting the bytes
    // come back is what makes this test fail for the right reason -- drop either pair of quotes in
    // copyToClipboardHint and the shell errors instead.
    //
    // The command reaches the shell through a SCRIPT FILE rather than through argv, which matters on
    // both platforms and was a genuine bug in the first version of this test (1051, re-read of
    // ca0266bc): `execFileSync("cmd", ["/c", <string>])` re-quotes its argument on the way in and
    // Windows rejected the result -- the test failed on CORRECT code, which is worse than not
    // existing. The two obvious repairs each destroy what the test is for:
    //
    //   - `execFileSync("cmd", ["/c", "type", file])` builds argv itself, so it never sees the
    //     helper's string and passes just as happily for the UNQUOTED helper.
    //   - asserting the quotes are present only re-pins the output format, which is the weakness
    //     that let the original defect ship.
    //
    // A script file has neither problem: the shell's own parser reads the helper's exact bytes, so
    // the quoting is what decides, and the failure is the user's failure verbatim.
    const shell = process.platform === "win32"
      ? { platform: "win32" as const, ext: ".cmd", run: (f: string) => execFileSync("cmd", ["/c", f], { encoding: "utf8" }), body: (c: string) => `@echo off\r\n${c.replace(" | clip", "")}\r\n` }
      : { platform: "darwin" as const, ext: ".sh", run: (f: string) => execFileSync("sh", [f], { encoding: "utf8" }), body: (c: string) => `${c.replace("pbcopy", "cat")}\n` };

    const hint = copyToClipboardHint(file, shell.platform);
    const script = path.join(mkdtempSync(path.join(tmpdir(), "oc-codexapp-spaced-run-")), `copy${shell.ext}`);
    writeFileSync(script, shell.body(hint!));
    expect(shell.run(script)).toContain(contents);
  });

  it("stays silent rather than guessing on linux and on anything unknown", () => {
    // wl-copy vs xclip vs xsel is session-dependent, and a wrong command is worse than none: the
    // file path is printed either way, so silence costs the user nothing they had before.
    expect(copyToClipboardHint("/tmp/setup.md", "linux")).toBeNull();
    expect(copyToClipboardHint("/tmp/setup.md", "aix")).toBeNull();
  });
});
