// Re-times `opencadre connect` end to end for the R5 ("under five minutes") clause, on a LOCAL hub,
// with no operator key, no network and nothing written outside a throwaway directory.
//
//   node_modules/tsx/dist/cli.mjs scripts/dev/r5-retime.ts [--runs 3] [--clients claude-code,codex]
//
// Why a local hub: the production re-time needs an operator key for the workspace, so it is
// operator-gated. A local hub measures the same CLI and the same hub code paths, and the one thing it
// CANNOT measure -- production network latency -- is named in the output rather than papered over.
//
// What the clock means, and what it cannot mean:
//
//   t0            the connect command is spawned (the R0 rows start at "command shown"; the human's
//                 typing delay is inside their number and not inside this one)
//   -> CLI done   the child exits: download, install, hooks, config. Purely mechanical.
//   -> online     the HUB's own stage machine says "online". This is NOT a client-side signal: the hub
//                 infers it from heartbeat recency, and it refuses to say "online" for a heartbeat that
//                 lands less than CLI_GRACE_MS (60 s) after the code was redeemed. So the last leg has a
//                 60-second FLOOR that no amount of machine speed removes, and above that floor it is
//                 whatever the human does next (a client that is open but idle sends nothing).
//                 This run measures the floor: the installed SessionStart hook is run as the client
//                 would, and one more heartbeat is sent just past the grace boundary.
//
// The numbers this prints are therefore a LOWER BOUND on a real stranger's experience, and the report
// says so. Anything that is not measured here is not claimed here.
//
// --scratch, and why it exists: this script's working directories default to tmpdir(). Until
// 2026-10-31 the suite's global teardown deleted every directory that APPEARED under tmpdir() during
// its own run, whatever the name, so a concurrent suite run could delete this script's directories
// mid-measurement. Observed on 2026-09-19: a run's home/project/cache directories were deleted between
// the install finishing and the installed hook being spawned, so the child died with ENOENT naming the
// node binary rather than the missing path. The teardown now touches only `oc-vitest-run-*`
// directories (tests/helpers/global-teardown.ts), so that hazard is gone; --scratch <dir> is still
// the way to keep this script's files, and its children's TEMP/TMP, off the shared temp root.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NODE = process.execPath;
const npmCli = [
  path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(NODE), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((p) => existsSync(p));
if (!npmCli) throw new Error(`could not find npm-cli.js next to ${NODE} -- run this with the node that has npm beside it`);

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    clients: { type: "string", default: "claude-code,codex" },
    "online-timeout-ms": { type: "string", default: "180000" },
    "poll-ms": { type: "string", default: "1000" },
    // "code" mints via POST /v1/connect-codes and reads the stage machine; "device" mints via
    // POST /v1/org/devices and reads DeviceStatus -- the two surfaces a stranger's connect is scored
    // on. The command the hub hands out is the same builder either way (src/rest.ts:671, :708).
    flow: { type: "string", default: "code" },
    scratch: { type: "string", default: "" },
    keep: { type: "boolean", default: false },
    json: { type: "string", default: "" },
  },
});
const RUNS = Number(values.runs);
const CLIENTS = values.clients.split(",").map((c) => c.trim()).filter(Boolean);
const ONLINE_TIMEOUT_MS = Number(values["online-timeout-ms"]);
const POLL_MS = Number(values["poll-ms"]);
const FLOW = values.flow;
// Outside the shared temp root by default only when one is asked for; see the header on --scratch.
const SCRATCH_ROOT = values.scratch ? path.resolve(values.scratch) : tmpdir();
mkdirSync(SCRATCH_ROOT, { recursive: true });

// The hub runs in THIS process and the CLI/hooks are children of it, so the hub can never be starved
// by a synchronous spawn. A database in memory keeps the run from touching any file on disk.
process.env.OPENCADRE_DB_PATH = ":memory:";
const { app } = await import("../../src/rest.js");
const { handleMcpRequest } = await import("../../src/mcp.js");
const { createOrganization, registerAgent } = await import("../../src/service.js");
// The repo's own reader of a client config, so the key used below is the key the install wrote, read
// by the same code `doctor` uses. It never logs the key and neither does this script.
const { readExistingServer } = (await import("../../cli/lib/clients.mjs")) as {
  readExistingServer: (a: { home: string; client: string }) => { found: boolean; url?: string; key?: string };
};

const server = http.createServer((req, res) => {
  if (req.url === "/mcp" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
      void handleMcpRequest(req, res);
    });
    return;
  }
  app(req, res);
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// The hub builds the command it hands the user from this, so setting it here is what makes the command
// point at the local hub instead of production. It is read per request, not at boot.
process.env.OPENCADRE_PUBLIC_HUB_URL = hub;

const { orgId } = createOrganization("R5 Retime");
const operatorKey = registerAgent(orgId, "Operator", { role: "operator", system: true }).apiKey;

const log = (...parts: unknown[]) => console.log(...parts);
const work: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(path.join(SCRATCH_ROOT, prefix));
  work.push(dir);
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`;

/** A real user's environment -- PATH intact, because the stranger has node and npx -- with every home
 * pointer and the npm cache redirected into throwaway directories. A cold cache is deliberate: it makes
 * the download leg of every run real instead of a cache hit that the first stranger would not get. */
function childEnv(home: string, cache: string, temp: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (v === undefined || upper.startsWith("OPENCADRE_") || upper.startsWith("CLAUDE_CODE_") || upper === "HOME" || upper === "USERPROFILE") continue;
    env[k] = v;
  }
  // TEMP/TMP follow the scratch root: a child's own temp files are exactly as sweepable as ours.
  return { ...env, HOME: home, USERPROFILE: home, OPENCADRE_HOOK_HOME: home, npm_config_cache: cache, TEMP: temp, TMP: temp };
}

function run(cmd: string, args: string[], env: Record<string, string>, cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string; spawnError: string | null }>((resolve) => {
    const child = spawn(cmd, args, { env, cwd });
    let out = "";
    let err = "";
    let settled = false;
    const done = (r: { code: number | null; out: string; err: string; spawnError: string | null }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // Without this, a spawn failure is an unhandled 'error' event and takes the whole run with it --
    // which is how the ENOENT above was first seen, reported as a crash rather than as one run's
    // outcome. A missing cwd (a swept scratch directory) surfaces here as ENOENT naming the command.
    child.on("error", (e) => done({ code: null, out, err, spawnError: `${(e as NodeJS.ErrnoException).code ?? "error"}: ${e.message}` }));
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end();
    child.on("close", (code) => done({ code, out, err, spawnError: null }));
  });
}

type Status = { state: string; stage: string; agentOnline: boolean; redeemedAt: string | null; lastSeenAt: string | null };
const status = async (code: string): Promise<Status> =>
  (await (await fetch(`${hub}/v1/connect-codes/${code}/status`, { headers: { authorization: `Bearer ${operatorKey}` } })).json()) as Status;

type Row = {
  client: string; run: number; cmd: string; cliExit: number | null;
  toCli: number; toInstalled: number | null; toOnline: number | null; total: number | null;
  redemptionToCli: number | null; graceFloorMs: number | null; outcome: string;
  hookPath: string | null; keyInConfig: string; mcp: string[]; spawnErrors: string[];
  flow: string; deviceConnectedMs: number | null; deviceStatusAtCli: string | null;
  sessionOnlineInsideGrace?: boolean; sessionOnlineInsideGraceMs?: number | null;
  sessionOnlineAfterGrace?: boolean; sessionOnlineAfterGraceMs?: number | null;
  projectEnabled?: boolean; cliNextSteps?: string[];
};

/** One connect, timed from the spawn of the command the hub handed out. */
async function oneRun(client: string, index: number): Promise<Row> {
  const home = scratch(`r5-${client}-home-`);
  const project = scratch(`r5-${client}-proj-`);
  const cache = scratch(`r5-${client}-npmcache-`);
  const temp = scratch(`r5-${client}-temp-`);
  const env = childEnv(home, cache, temp);

  const post = async (route: string, body: unknown) =>
    (await (await fetch(`${hub}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json()) as { code: string; command: string; deviceId?: string };

  const created = FLOW === "device"
    ? await post("/v1/org/devices", { name: `r5-${client}-${Date.now().toString(36)}-${index}` })
    : await post("/v1/connect-codes", { agentName: `r5-${client}-${Date.now().toString(36)}-${index}`, client });

  /** This device's own status row -- what the console's chip polls (public/app/app.js). */
  const deviceStatus = async (deviceId: string): Promise<string | null> => {
    const list = (await (await fetch(`${hub}/v1/org/devices`, { headers: { authorization: `Bearer ${operatorKey}` } })).json()) as {
      devices?: Array<{ deviceId: string; status: string }>;
    };
    return list.devices?.find((d) => d.deviceId === deviceId)?.status ?? null;
  };

  /** What the console's own live-session view shows (public/app/app.js reads this route): the row's
   *  `online` flag is the hub's heartbeat verdict for the session the client created. This is the
   *  device flow's real instrument -- the device has no stage machine, but its SESSION does have a
   *  presence row, and that row is what a person looking at the console is looking at. */
  const liveSessions = async (): Promise<Array<{ name?: string; online?: boolean }>> => {
    const r = (await (await fetch(`${hub}/v1/org/sessions?status=live`, { headers: { authorization: `Bearer ${operatorKey}` } })).json()) as {
      sessions?: Array<{ name?: string; online?: boolean }>;
    };
    return r.sessions ?? [];
  };

  const row: Row = {
    client, run: index, cmd: created.command, cliExit: null,
    toCli: 0, toInstalled: null, toOnline: null, total: null,
    redemptionToCli: null, graceFloorMs: null, outcome: "pending",
    hookPath: null, keyInConfig: "unknown", mcp: [], spawnErrors: [],
    flow: FLOW, deviceConnectedMs: null, deviceStatusAtCli: null,
  };

  // Run the hub's OWN command, substituting only the node/npm that runs it (the same npm, named
  // explicitly: on this box `node` on PATH is the x64 build and the ARM64 one is a separate install).
  const words = created.command.split(" ").filter((w) => w !== "npx" && w !== "-y");
  const t0 = Date.now();
  const cli = await run(NODE, [npmCli, "exec", "--yes", "--", ...words], env, project);
  row.toCli = Date.now() - t0;
  row.cliExit = cli.code;
  if (cli.spawnError) {
    row.spawnErrors.push(`cli: ${cli.spawnError}`);
    row.outcome = "cli could not start";
    row.total = row.toCli;
    log(`    CLI could not start: ${cli.spawnError}`);
    return row;
  }
  if (cli.code !== 0) {
    row.outcome = "cli failed";
    row.total = row.toCli;
    log(`    CLI exited ${cli.code}: ${(cli.err || cli.out).trim().split("\n").slice(0, 3).join(" | ")}`);
    return row;
  }
  if (cli.err.trim()) log(`    CLI stderr: ${cli.err.trim().split("\n").slice(0, 2).join(" | ")}`);

  // The CLI's OWN next-steps list, kept verbatim. This is the artefact the manual-step table is
  // checked against: an entry in that table has to be a line the user is actually shown, and a table
  // row with no matching line here is the harness asserting a step the CLI never asks for. It is also
  // how "no next step" and "no console next step" stay different findings -- the CLI prints a project
  // step on the terminal path (opencadre.mjs:640) and the console prints none, and only the captured
  // text tells those apart from inside a run.
  const outLines = cli.out.split("\n");
  const nextAt = outLines.findIndex((l) => l.startsWith("Next steps"));
  // ONE header, TWO item shapes -- and the difference is the client, not the flow. claude-code gets
  // `- ` bullets; codex gets a numbered `1) ...` list, because main() returns early at
  // `opencadre.mjs:767` into printCodexNext and that function prints its own block under the same
  // `Next steps:` header (`opencadre.mjs:812`). A `- `-only filter read the codex list as EMPTY, so
  // the log said `next steps 0 printed by the CLI` for a run that had printed five -- a line that
  // reads as "the CLI asked the user for nothing" when the truth is "this extractor knows one shape".
  // Found by reading the CLI's source rather than shipping the inference the log invited.
  row.cliNextSteps = nextAt < 0
    ? []
    : outLines.slice(nextAt + 1)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- ") || /^\d+\)\s/.test(l))
        .map((l) => l.replace(/^(?:-\s+|\d+\)\s+)/, ""));
  if (nextAt < 0) row.spawnErrors.push("the CLI printed no 'Next steps' block");
  log(`    next steps  ${row.cliNextSteps.length} printed by the CLI: ${row.cliNextSteps.map((s) => `"${s.slice(0, 46)}${s.length > 46 ? "…" : ""}"`).join(" | ")}`);

  // The client's own SessionStart hook, read out of the config the install just wrote and run as the
  // client would run it. Running the CONFIG's command (rather than a guess at an equivalent) is the
  // point: it proves the wiring the install produced is the wiring that connects.
  const hook = installedSessionStart(home, client);
  row.hookPath = hook?.args[0] ?? null;
  const runHook = async (when: string) => {
    if (!hook) return;
    if (!existsSync(hook.args[0])) row.spawnErrors.push(`${when}: hook path does not exist: ${hook.args[0]}`);
    const r = await run(NODE, hook.args, env, project);
    if (r.spawnError) row.spawnErrors.push(`${when}: ${r.spawnError}`);
    else if (r.code !== 0) row.spawnErrors.push(`${when}: hook exited ${r.code}: ${(r.err || r.out).trim().split("\n")[0]}`);
  };
  if (!hook) log(`    no SessionStart hook was installed for ${client}`);
  await runHook("hook@install");

  // The credential the install wrote, and the first MCP request the client's server would make with
  // it. src/mcp.ts heartbeats on every authenticated /mcp call, before the transport routes it, so
  // this is the request shape -- and the only request shape -- that can flip the stage. The hooks do
  // NOT heartbeat: they can be installed and exit 0 while the hub still says "installed" forever.
  // `auto` is not a client with a config of its own: it sets up whichever tools it finds, so the key
  // has to be read out of whichever of them it actually wrote. readExistingServer takes a concrete
  // client (cli/lib/clients.mjs), which is also why the console's own `auto` command needs this.
  // The two flows carry the credential in different places, which is the single easiest thing to get
  // wrong when re-timing them: the CODE flow writes a named `opencadre` entry with an agent key inline
  // in the client's own config; the DEVICE flow writes a keyless `opencadre-session` entry and keeps a
  // device credential in ~/.opencadre/credentials.json. Reading only the named entry -- which is what
  // readExistingServer does -- finds nothing on a device connect, and that absence is a fact about the
  // identity model, not about the install. Verified by inspection of a kept scratch home on 2026-09-19.
  const keyClient = client === "auto" ? (existsSync(path.join(home, ".codex", "config.toml")) ? "codex" : "claude-code") : client;
  const cred = ((): { key?: string; where: string } => {
    if (FLOW !== "device") {
      const installed = readExistingServer({ home, client: keyClient });
      return { key: installed.key, where: !installed.found ? "no opencadre entry" : installed.key ? "client config" : "entry but no key" };
    }
    try {
      // The device credential is nested one level down, under `computer` -- the file holds
      // { computer: { hub, credential, deviceId } }, not a top-level `credential`. A name-only grep
      // of the file reports `credential` as a key but says nothing about its depth, so a top-level
      // read finds nothing and looks exactly like a missing credential. Structure read 2026-09-19.
      const raw = JSON.parse(readFileSync(path.join(home, ".opencadre", "credentials.json"), "utf8")) as {
        computer?: { credential?: string };
      };
      const key = raw.computer?.credential;
      return key
        ? { key, where: "~/.opencadre/credentials.json (computer.credential)" }
        : { where: "credentials.json with no computer.credential" };
    } catch {
      return { where: "no credentials.json" };
    }
  })();
  row.keyInConfig = cred.where;
  const firstMcpCall = async (when: string) => {
    if (!cred.key) {
      row.spawnErrors.push(`${when}: ${cred.where}, so no MCP request could be made`);
      return;
    }
    const res = await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${cred.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = (await res.text()).replace(/agt_[\w-]+/g, "agt_<redacted>").slice(0, 160);
    row.mcp.push(`${when}: HTTP ${res.status}`);
    if (!res.ok) row.spawnErrors.push(`${when}: /mcp refused the installed credential (HTTP ${res.status}) ${text}`);
  };
  // The device flow cannot use the raw call above, and the reason is a fact about the identity model
  // rather than about the connect: a device credential is never an identity by itself
  // (src/devices.ts:20). It must be paired with the headers naming the session, the tool and the
  // project, and those are produced by the INSTALLED PROXY (~/.opencadre/bin/opencadre-mcp.mjs,
  // spawned by the client as the stdio server "opencadre-session"). A raw fetch carrying only the
  // credential is refused 401 "session header required" -- reproducing that here would be measuring
  // my own mistake. So the device flow drives the installed proxy, which is what a real chat does.
  const mcpViaProxy = async (when: string) => {
    const proxy = path.join(home, ".opencadre", "bin", "opencadre-mcp.mjs");
    if (!existsSync(proxy)) {
      row.spawnErrors.push(`${when}: no installed proxy at ${proxy}`);
      return;
    }
    // Claude Code hands the server this variable and nothing else; the proxy refuses to act without
    // a session id, by design ("nothing reaches the hub"), so the client's own channel is what the
    // harness must supply. It is a throwaway per run and is not an identity of mine.
    const childEnv = { ...env, CLAUDE_CODE_SESSION_ID: `r5-retime-${randomUUID()}` };
    const reply = await new Promise<string>((resolve) => {
      const child = spawn(NODE, [proxy, "--client", keyClient], { env: childEnv, cwd: project });
      let out = "";
      let err = "";
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(out.trim() || err.trim()); } };
      child.on("error", (e) => { err += `spawn ${(e as NodeJS.ErrnoException).code}`; done(); });
      child.stdout.on("data", (d) => { out += String(d); if (out.includes("\n")) { child.stdin.end(); } });
      child.stderr.on("data", (d) => { err += String(d); });
      child.on("close", done);
      const kill = setTimeout(() => { child.kill(); done(); }, 20_000);
      child.on("close", () => clearTimeout(kill));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    });
    const line = reply.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "(no reply)";
    const clean = line.replace(/agt_[\w-]+/g, "agt_<redacted>").slice(0, 150);
    row.mcp.push(`${when}: ${clean}`);
    if (!line.includes("\"result\"")) row.spawnErrors.push(`${when}: the installed proxy did not get a result from /mcp: ${clean}`);
    return line;
  };
  if (FLOW !== "device") await firstMcpCall("mcp@install");

  // The device flow has no stage machine: what the console shows is DeviceStatus, and `connected` is
  // set by the REDEEM itself (src/devices.ts:220) -- the instant the CLI starts working, not the
  // instant the client checks in. So this measures the chip, then the earliest the client could
  // really be talking to the hub on the same connect (the first MCP call past the grace), and puts
  // both numbers in one row.
  if (FLOW === "device") {
    // A shell-run `opencadre connect` enables NO project: enable-current is called only when the
    // command runs FROM a chat (cli/bin/opencadre.mjs:607, `fromChat`). Without it the hub answers
    // every device request for this folder as an empty server (src/mcp.ts:124, instructions
    // "OpenCadre isn't enabled for this project.") -- the client works, the hub answers 200, and the
    // chat has no tools. The harness enables the folder the way a chat-run connect does, so the floor
    // leg below measures the client path rather than that separate gap; the gap is reported on its own.
    const projectKey = `local:${path.basename(project).toLowerCase()}`;
    const enable = await fetch(`${hub}/v1/devices/projects/enable-current`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${cred.key}`,
        "x-opencadre-project": projectKey,
        "x-opencadre-project-name": path.basename(project),
      },
    });
    row.projectEnabled = enable.status === 200;
    if (enable.status !== 200) row.spawnErrors.push(`the harness could not enable ${projectKey} (HTTP ${enable.status})`);
    await mcpViaProxy("mcp@install");
    row.deviceStatusAtCli = await deviceStatus(created.deviceId!);
    if (row.deviceStatusAtCli === "connected") row.deviceConnectedMs = Date.now() - t0;
    const until = Date.now() + 20_000;
    while (row.deviceConnectedMs === null && Date.now() < until) {
      await sleep(POLL_MS);
      if ((await deviceStatus(created.deviceId!)) === "connected") row.deviceConnectedMs = Date.now() - t0;
    }
    if (row.deviceConnectedMs === null) {
      row.outcome = "console never said connected";
      row.total = row.toCli;
      return row;
    }
    log(`    console  "Connected ✓" at ${clock(row.deviceConnectedMs)} (DeviceStatus, flipped by the redeem)`);
    // Only THIS run's session counts. The hub lives for the whole invocation, so every earlier run's
    // session is still in the workspace and still online -- a bare `some(online)` reads the previous
    // run's verdict and calls it this one's. Matching on the device id the run created is the set.
    const mine = (rows: Array<{ deviceId?: string; online?: boolean }>) => rows.find((s) => s.deviceId === created.deviceId) ?? null;
    // READ ORDER MATTERS, and this read has to happen HERE -- before the floor sleep, not after it.
    // A first version of this harness read the row after sleeping to redeem+61s and still called the
    // result `sessionOnlineInsideGrace`. It was read 60 seconds past the grace, so the label named a
    // window the read was not in: the code-flow floor would have looked absent from the device flow
    // whether or not it applies there. The read below is the one that is actually inside the window --
    // it happens right after the CLI exits, ~0:03, with no MCP call past the floor yet.
    const inside = mine(await liveSessions());
    row.sessionOnlineInsideGrace = inside?.online === true;
    row.sessionOnlineInsideGraceMs = inside ? Date.now() - t0 : null;
    // The redeem is what flipped the chip, so the 60 s floor is measured from there.
    await sleep(Math.max(0, row.deviceConnectedMs + 61_000 - (Date.now() - t0)));
    row.graceFloorMs = Date.now() - t0;
    await mcpViaProxy("mcp@grace");
    const past = mine(await liveSessions());
    row.sessionOnlineAfterGrace = past?.online === true;
    row.sessionOnlineAfterGraceMs = past ? Date.now() - t0 : null;
    log(`    console's session row for this device: ${inside ? `online=${inside.online} at ${clock(row.sessionOnlineInsideGraceMs!)}` : "absent"} inside the grace, ${past ? `online=${past.online} at ${clock(row.sessionOnlineAfterGraceMs!)}` : "absent"} past the floor`);
    row.toOnline = Date.now() - t0;
    // Total stays the CHIP: that is the only number the console ever shows a stranger.
    row.total = row.deviceConnectedMs;
    // Names the two things that were actually measured. The earlier wording ("client could first be
    // connected at 1:03") described a floor the device flow does not have: 1:03 here is the instant
    // the harness finished WAITING OUT the code flow's 60 s window so it could test the far side of
    // it. Calling that "the earliest the client could connect" is the measurement-as-a-claim error.
    row.outcome = `chip at ${clock(row.deviceConnectedMs)}; session row online inside the grace=${row.sessionOnlineInsideGrace ?? "unread"}, past the redeem+61s floor=${row.sessionOnlineAfterGrace ?? "unread"} (1:03 is the harness waiting the floor out, not a floor of this flow)`;
    return row;
  }

  const after = await status(created.code);
  row.redemptionToCli = after.redeemedAt ? Date.now() - Date.parse(after.redeemedAt) : null;

  // A client that is open but idle sends nothing, so the stage cannot flip on its own; the hub refuses
  // "online" for any heartbeat younger than the grace. Poll to the grace boundary, heartbeat there, and
  // that instant is the FLOOR. Everything above it belongs to the human.
  const started = Date.now();
  let lastStage = "";
  while (Date.now() - started < ONLINE_TIMEOUT_MS) {
    const s = await status(created.code);
    if (s.stage !== lastStage) {
      lastStage = s.stage;
      if (s.stage === "installed" && row.toInstalled === null) row.toInstalled = Date.now() - t0;
      if (s.stage === "online") {
        row.toOnline = Date.now() - t0;
        row.total = row.toOnline;
        row.outcome = "online";
        break;
      }
    }
    if (s.redeemedAt) {
      const sinceRedeem = Date.now() - Date.parse(s.redeemedAt);
      // Past the grace with no heartbeat of ours, the stage is waiting on traffic only a human can
      // produce -- so send the one the client would send on the user's next action, and record that the
      // number we get is the floor rather than a latency. Once.
      if (sinceRedeem > 61_000 && row.graceFloorMs === null) {
        row.graceFloorMs = Date.now() - t0;
        await firstMcpCall("mcp@grace");
      }
    }
    await sleep(POLL_MS);
  }
  if (row.outcome === "pending") {
    row.outcome = !hook
      ? "no SessionStart hook installed"
      : lastStage === "expired"
        ? "code expired"
        : `stuck at ${lastStage || "unknown"}`;
  }
  return row;
}

/** The SessionStart command the install wrote for this client, or null when the file is not there. */
function installedSessionStart(home: string, client: string): { args: string[] } | null {
  try {
    const file = client === "codex" ? path.join(home, ".codex", "hooks.json") : path.join(home, ".claude", "settings.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const entries = config?.hooks?.SessionStart ?? [];
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command !== "string" || !h.command.includes("opencadre-awareness")) continue;
        // The command is `node "<abs path>" --client <c>` -- split on the quoted path so a home with a
        // space in it still yields the right argv.
        const m = /^node\s+"([^"]+)"(.*)$/.exec(h.command);
        if (!m) continue;
        return { args: [m[1], ...m[2].trim().split(/\s+/).filter(Boolean)] };
      }
    }
  } catch {
    /* no config written, or unreadable: the caller reports a missing hook as itself */
  }
  return null;
}

log(`hub            ${hub} (local, in-process; production latency is NOT measured here)`);
log(`node           ${NODE}`);
log(`scratch        ${SCRATCH_ROOT}${SCRATCH_ROOT === tmpdir() ? "  (the shared temp root: pass --scratch on a box where the suite runs)" : ""}`);
log(`clients        ${CLIENTS.join(", ")}   runs each: ${RUNS}`);
log(`flow           ${FLOW}${FLOW === "device" ? "  (what the console hands out: DeviceStatus, not the stage machine)" : ""}\n`);

const rows: Row[] = [];
for (const client of CLIENTS) {
  for (let i = 1; i <= RUNS; i++) {
    log(`  ${client} run ${i}/${RUNS} ...`);
    // A fault inside one run must cost one row, not the batch: the rest of the runs still measure.
    const row = await oneRun(client, i).catch((e: unknown): Row => ({
      client, run: i, cmd: "", cliExit: null, toCli: 0, toInstalled: null, toOnline: null, total: null,
      redemptionToCli: null, graceFloorMs: null, outcome: `harness error: ${e instanceof Error ? e.message : String(e)}`,
      hookPath: null, keyInConfig: "unknown", mcp: [], spawnErrors: [],
      flow: FLOW, deviceConnectedMs: null, deviceStatusAtCli: null,
    }));
    rows.push(row);
    log(`    command -> CLI done ${clock(row.toCli)}   CLI done -> online ${row.toOnline !== null && row.toInstalled !== null ? clock(row.toOnline - row.toInstalled) : "—"}   total ${row.total !== null ? clock(row.total) : "—"}   ${row.outcome}`);
    if (row.hookPath) log(`    hook   ${row.hookPath}`);
    log(`    key    in installed ${client} config: ${row.keyInConfig}   mcp: ${row.mcp.join(", ") || "none"}`);
    if (row.graceFloorMs !== null) log(`    grace  floor reached at ${clock(row.graceFloorMs)} (the MCP call that flips the stage is made just past the 60 s CLI_GRACE_MS boundary)`);
    for (const e of row.spawnErrors) log(`    !!     ${e}`);
  }
}

// "Did this run reach online" is read from what was MEASURED, because the two flows record it
// differently and one of them does not use the word. The code flow sets `outcome = "online"` on the
// path that observed the stage (:444). The device flow writes a descriptive sentence there (:424)
// and records the observation in `sessionOnlineAfterGrace`. This predicate used to be the literal
// string comparison for both, so a device batch whose every run succeeded summarised as
// `| auto | 0 of 3 | ... | never reached online |` next to a JSON holding online=true three times
// (device2.json, 2026-09-19). A summary that reports a false red is worse than no summary: the run
// was correct and the instrument called it a failure.
const reachedOnline = (r: Row) => (FLOW === "device"
  ? r.deviceConnectedMs !== null && r.sessionOnlineAfterGrace === true
  : r.outcome === "online");

const cell = (ms: number | null) => (ms === null ? "—" : clock(ms));
log(`\n| Client | n | Command → CLI done | ${FLOW === "device" ? "CLI done → first MCP call past the floor" : "CLI done → hub says online"} | ${FLOW === "device" ? "Console says connected" : "Total"} | Result |`);
log("|---|---|---|---|---|---|");
for (const client of CLIENTS) {
  const ok = rows.filter((r) => r.client === client && reachedOnline(r));
  if (ok.length === 0) {
    log(`| ${client} | 0 of ${RUNS} | — | — | — | never reached online |`);
    continue;
  }
  const med = (pick: (r: Row) => number | null) => {
    const xs = ok.map(pick).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  };
  const total = med((r) => r.total);
  log(`| ${client} | ${ok.length} of ${RUNS} | ${cell(med((r) => r.toCli))} | ${cell(med((r) => (r.toOnline !== null && r.toInstalled !== null ? r.toOnline - r.toInstalled : null)))} | ${cell(total)} | ${total !== null && total <= 300000 ? "under 5 min" : "over 5 min"} |`);
}
log("\n(median of the runs that reached online; every run is in the JSON)");

if (values.json) {
  const out = path.resolve(ROOT, values.json);
  mkdirSync(path.dirname(out), { recursive: true });
  const detail = rows.map((r) => ({
    ...r, redemptionToCliMs: r.redemptionToCli, graceFloorMs: r.graceFloorMs,
    command: r.cmd.replace(/(--code )\S+/, "$1<redacted>"),
    node: NODE, hub, when: new Date().toISOString(),
  }));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, `${JSON.stringify(detail, null, 2)}\n`);
  log(`\nwrote ${out}`);
}

server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
if (values.keep) {
  log(`\n--keep: left ${work.length} directories in place for inspection:`);
  for (const dir of work) log(`  ${dir}`);
  process.exit(0);
}
for (const dir of work) rmSync(dir, { recursive: true, force: true });
log(`removed ${work.length} throwaway directories`);
