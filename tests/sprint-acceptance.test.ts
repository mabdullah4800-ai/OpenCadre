import type { AddressInfo } from "node:net";
import http from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SPAWN_TEST_TIMEOUT_MS, waitFor } from "./helpers/spawn.js";

/** THE SPRINT ACCEPTANCE TEST. This is the definition of "sprint done", so it is one unbroken run of
 * the whole promise rather than six suites that each pass:
 *
 *   a stranger signs up (no waitlist) -> connects Claude Code AND Codex -> each chat gets its OWN
 *   identity -> they coordinate visibly -> the hub restarts -> nothing is lost
 *
 * Every other test in this repo covers one link. This one exists because the failures that matter on a
 * launch path live BETWEEN links: a step that works alone and not in sequence, or a step whose
 * precondition the previous step silently failed to establish.
 *
 * EVERY LINK NOW USES THE REAL PATH. Two earlier versions of this file did not, and both are recorded
 * here because each looked green while proving less than it claimed:
 *   - Link 1 probed a `/v1/signup` route that has never existed. Sign-up is sign-in + POST
 *     /v1/workspaces behind the OPENCADRE_SIGNUP flag (#324); there is no /v1/signup anywhere. Probing
 *     a fiction left the sprint's opening clause untested rather than failed.
 *   - Link 5 hand-wrote `credentials.json` as `devices["claude-code"]`. A real computer connect writes
 *     `computer.credential`. So the wake "passed" against a file built to match the test's own
 *     expectation -- self-consistent, and no evidence that a real machine connect works at all.
 * Both now go through the real commands, so a green run means the commands work rather than that the
 * fixture agrees with itself.
 *
 * Nothing is mocked except the harness binaries (no real Claude Code or Codex is launched) and
 * Supabase Auth, which has no local instance; the stand-in signs real ES256 tokens so the hub's own
 * verification runs for real. The hub, the CLI, the installed helpers, the device flow and the restart
 * are all real.
 *
 * Requires: the CLI redeems many codes from 127.0.0.1 here, so lift the per-IP limit before the app
 * loads, and open sign-up is switched on in beforeAll for the sprint's opening clause. */
process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";
// THE CARDLESS TRIAL MODE, pinned (src/billing.ts trialMode). The sprint's clauses start from a signup that mints the first key on the hub-side trial. The card-required flow that is the launch default
// is covered by tests/card-trial.test.ts.
process.env.OPENCADRE_TRIAL_MODE = "cardless";


const CLI = path.join(process.cwd(), "cli", "bin", "opencadre.mjs");

// --- A stand-in Supabase Auth ---------------------------------------------------------------------
// Shape copied from tests/accounts.test.ts, which is the only place a person session can be obtained
// locally. Real ES256 signing, so the hub verifies rather than trusts.
const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "test-key";
let supabaseUrl = "";
interface FakeUser { id: string; email: string; name: string }
const STRANGER: FakeUser = { id: "u-stranger", email: "stranger@example.com", name: "Stranger" };
const codes = new Map<string, { challenge: string; user: FakeUser }>();

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "ES256", kid: KID })}.${enc(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key: signer.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

const fakeAuth = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return json(200, { keys: [{ ...signer.publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" }] });
    }
    // The browser hits /authorize directly, with no API key, exactly as with real Supabase.
    if (url.pathname === "/auth/v1/authorize") {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, user: STRANGER });
      return res.writeHead(302, { location: `${url.searchParams.get("redirect_to")}?code=${code}` }).end();
    }
    if (req.headers.apikey !== "sb_publishable_test") return json(401, { message: "Invalid API key" });
    if (url.pathname === "/auth/v1/settings") return json(200, { external: { github: true, google: false, email: true } });
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const { auth_code, code_verifier } = JSON.parse(raw);
      const entry = codes.get(auth_code);
      if (!entry || entry.challenge !== createHash("sha256").update(String(code_verifier)).digest("base64url")) {
        return json(400, { msg: "invalid flow state" });
      }
      codes.delete(auth_code);
      return json(200, {
        access_token: jwt({ sub: entry.user.id, iss: `${supabaseUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: entry.user.email }),
        user: { id: entry.user.id, email: entry.user.email, email_confirmed_at: "2026-09-15T00:00:00Z", user_metadata: { full_name: entry.user.name } },
      });
    }
    json(404, { msg: "not found" });
  });
});

// --- The hub --------------------------------------------------------------------------------------
let server: http.Server;
let hub: string;
let dbPath: string;
let home: string;
let work: string;

/** Boots the real app. `freshModules` forces a NEW module graph, which is what makes link 6's restart
 * a real one: db.ts holds a module-level singleton handle, so without it a "restart" would re-open only
 * the HTTP listener and leave the original database handle in place -- proving the server can rebind a
 * port, and nothing about whether data survives. */
async function startHub(freshModules = false): Promise<void> {
  if (freshModules) vi.resetModules();
  const { app } = await import("../src/rest.js");
  const { handleMcpRequest } = await import("../src/mcp.js");
  // This harness served only `app`, so POST /mcp answered 404 -- a hub a client's own MCP traffic can
  // never reach. Nothing noticed for five links because every one of them talks to the hub over a plain
  // fetch; the route is only load-bearing for the client's own traffic, which link 4b is the first leg
  // to drive. The route is not an express route at all: src/index.ts:38 tests `req.url === "/mcp"`
  // against a raw http.Server before `:74` hands everything else to `app`.
  //
  // What is copied from production is the part that decides whether a request REACHES the handler: the
  // :38 predicate (POST and DELETE), the body read off the raw stream and injected as `req.body`, and
  // the DELETE passthrough. Production also carries three guards this harness deliberately omits --
  // the rate limit (:40-45, 429), the body cap (:50-55, 413) and the JSON try/catch (:61-67, 400) --
  // because a test that trips its own 429 or 413 while asserting something else reports a failure
  // about the wrong thing. So: same reachability, not the same hardening.
  const s = http.createServer((req, res) => {
    if (req.url === "/mcp" && (req.method === "POST" || req.method === "DELETE")) {
      if (req.method === "DELETE") { void handleMcpRequest(req, res); return; }
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
  await new Promise<void>((r) => s.listen(0, r));
  server = s;
  hub = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

let tempDir: (prefix?: string) => string;
let gitProject: (name: string, remote?: string) => string;
let childEnv: (home: string, extra?: Record<string, string>) => Record<string, string>;
let runNode: (script: string, args: string[], env: Record<string, string>, cwd?: string) => Promise<{ code: number | null; out: string; err: string }>;

beforeAll(async () => {
  await new Promise<void>((r) => fakeAuth.listen(0, r));
  supabaseUrl = `http://127.0.0.1:${(fakeAuth.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.OPENCADRE_SIGNUP = "open"; // open sign-up is the sprint's opening clause

  ({ tempDir, gitProject, childEnv, runNode } = await import("./helpers/device-hub.js"));
  dbPath = path.join(tempDir("sprint-db-"), "hub.db");
  process.env.OPENCADRE_DB_PATH = dbPath;
  home = tempDir("sprint-home-");
  // The folder the stranger signs up FROM: a real checkout with its own origin, so the project key is
  // isolated. Run against this repo instead and sessions/join returns the repo's own live named agent,
  // which makes "each chat gets its own identity" pass while proving nothing.
  work = gitProject("stranger", "https://github.com/sprint-acceptance/stranger.git");
  await startHub();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => fakeAuth.close(() => r()));
});

/** The whole browser flow for the stranger: /auth/start (PKCE) -> the provider -> /auth/callback. */
async function signIn(): Promise<string> {
  const start = await fetch(`${hub}/v1/auth/start?provider=github`, { redirect: "manual" });
  const pkce = start.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("oc_pkce="))!;
  const back = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const callback = await fetch(back.headers.get("location")!, { redirect: "manual", headers: { cookie: pkce } });
  return callback.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("oc_session=") && c !== "oc_session=")!;
}

/** Names the failing link, so a red run says WHICH promise broke rather than "the test failed". */
const LINKS = ["1 sign-up", "2 connect Claude Code", "3 connect Codex", "4 identity per chat", "5 coordinate", "6 restart, nothing lost"] as const;
const links = (n: number) => `LINK ${LINKS[n - 1]} FAILED`;

describe("SPRINT ACCEPTANCE: sign up -> connect both harnesses -> coordinate -> restart -> nothing lost", { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it("runs all six links in order", async () => {
    // ---- LINK 1: a stranger signs up -- no waitlist, no admin token, no operator in the loop.
    const cookie = await signIn();
    expect(cookie, links(1)).toMatch(/^oc_session=/);
    const created = await fetch(`${hub}/v1/workspaces`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Stranger Co" }),
    });
    expect(created.status, `${links(1)}: POST /v1/workspaces must create the workspace`).toBe(201);
    const { agent } = (await created.json()) as { workspace: { orgId: string }; agent: { agentId: string; apiKey: string } };
    // The first key must be an OPERATOR key. Minting a connect code needs connectCodes.manage, and a
    // plain agent key is refused 403 there -- so if sign-up handed out a plain agent key, the very
    // first thing the sprint promises a stranger ("connect a harness") would fail with an error they
    // cannot diagnose. Asserted here because it gates every link below.
    expect(agent.apiKey, `${links(1)}: sign-up must hand out a working agent key`).toMatch(/^agt_[0-9a-f]{48}$/);
    const operatorKey = agent.apiKey;

    // ---- LINK 2: connect Claude Code, with the key sign-up just issued.
    const c1 = await (await fetch(`${hub}/v1/connect-codes`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ agentName: "Sprint-Claude", client: "claude-code" }),
    })).json() as { code: string };
    const r2 = await runNode(CLI, ["connect", "--hub", hub, "--code", c1.code, "--home", home, "--client", "claude-code"], childEnv(home));
    expect(r2.code, `${links(2)}: exit=${r2.code} err=${JSON.stringify(r2.err.slice(0, 300))}`).toBe(0);
    expect(r2.out, links(2)).toContain("Connected as Sprint-Claude");
    const claudeCfg = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    const claudeKey = claudeCfg.mcpServers?.opencadre?.headers?.Authorization?.replace(/^Bearer /, "") ?? "";
    expect(claudeKey, links(2)).toMatch(/^agt_[0-9a-f]{48}$/);
    expect(r2.out, `${links(2)}: the key must never be printed`).not.toContain(claudeKey);

    // ---- LINK 3: connect Codex on the SAME machine, in the same run.
    const c2 = await (await fetch(`${hub}/v1/connect-codes`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ agentName: "Sprint-Codex", client: "codex" }),
    })).json() as { code: string };
    const r3 = await runNode(CLI, ["connect", "--hub", hub, "--code", c2.code, "--home", home, "--client", "codex"], childEnv(home));
    expect(r3.code, `${links(3)}: exit=${r3.code} err=${JSON.stringify(r3.err.slice(0, 300))}`).toBe(0);
    const codexKey = (readFileSync(path.join(home, ".codex", "config.toml"), "utf8").match(/agt_[0-9a-f]{48}/)?.[0]) ?? "";
    expect(codexKey, links(3)).toMatch(/^agt_/);
    expect(codexKey, `${links(3)}: two harnesses must not share one identity`).not.toBe(claudeKey);

    // ---- LINK 4: per-chat identity, through a REAL machine connect.
    //
    // `ocd_` is the machine flow, not the `oc_` agent flow link 2 used, and the distinction is the
    // point: /v1/sessions/join refuses anything but a DEVICE credential, because one credential naming
    // many chats is what per-chat identity means. This must be a real `connect` run: the previous
    // version hand-wrote credentials.json in the shape the test expected, so it validated its own
    // fixture rather than the product.
    const { projectHeaders } = await import("../scripts/opencadre-config.mjs");
    const project = projectHeaders(work) as unknown as Record<string, string>;
    expect(project["x-opencadre-project"], `${links(4)}: the folder must yield a project key`).toBeTruthy();
    const enable = await fetch(`${hub}/v1/org/projects`, {
      method: "PUT", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ projectKey: project["x-opencadre-project"], enabled: true }),
    });
    expect(enable.status, `${links(4)}: the workspace must be able to enable a project`).toBe(200);

    const machineHome = tempDir("sprint-machine-");
    const dev = await (await fetch(`${hub}/v1/org/devices`, {
      method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Sprint PC", client: "claude-code" }),
    })).json() as { code: string };
    const r4 = await runNode(CLI, ["connect", "--hub", hub, "--code", dev.code, "--home", machineHome, "--client", "claude-code"], childEnv(machineHome));
    expect(r4.code, `${links(4)}: exit=${r4.code} err=${JSON.stringify(r4.err.slice(0, 300))}`).toBe(0);
    const credPath = path.join(machineHome, ".opencadre", "credentials.json");
    expect(existsSync(credPath), `${links(4)}: connect must write credentials.json`).toBe(true);
    const deviceCredential = (JSON.parse(readFileSync(credPath, "utf8")) as { computer?: { credential?: string } }).computer?.credential ?? "";
    expect(deviceCredential, `${links(4)}: connect must write computer.credential, not devices[...]`).toBeTruthy();

    const join = async (sid: string) => {
      const res = await fetch(`${hub}/v1/sessions/join`, {
        method: "POST", headers: { authorization: `Bearer ${deviceCredential}`, "x-opencadre-session": sid, ...project },
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as { agentName?: string } };
    };
    const chatOne = await join("sprint-chat-1");
    const chatTwo = await join("sprint-chat-2");
    // 201 = created on this join, 200 = it already existed. Both succeed.
    expect([200, 201], links(4)).toContain(chatOne.status);
    expect([200, 201], links(4)).toContain(chatTwo.status);
    expect(chatOne.body.agentName, `${links(4)}: two chats must not collapse to one identity (got "${chatOne.body.agentName}" twice)`).not.toBe(chatTwo.body.agentName);

    // ---- LINK 4b: the SAME shipped path, with the OTHER client.
    //
    // Everything above drives the console's own `ocd_` flow -- the one public/app/app.js:1740 ships and
    // the Connect tab's single primary action uses -- but only with claude-code, the only client that
    // hands this command a session id (`fromChat`, cli/bin/opencadre.mjs). Links 2 and 3 do prove both
    // clients, over `POST /v1/connect-codes` -- the `oc_` flow that same console comment calls retired.
    // So a green run read as "a stranger connects Claude Code and Codex today" was proving the retired
    // path for both clients and the shipped path for one. This leg closes that: codex is connected
    // through the flow the product actually offers, and its chats are proved to get their own names.
    //
    // Codex is also the client whose identity model is least certain, so the assertion runs through real
    // proxy processes rather than a hand-set header. Codex gives its MCP server no session id and runs
    // one server process per chat, so `sessionIdSource: { from: "process" }` makes process identity
    // stand in for chat identity. That declaration is an assumption this suite CANNOT confirm, and the
    // file says so at scripts/opencadre-clients.mjs:55, upper case and so easy to miss with a
    // lower-case grep: "THAT PROPERTY CANNOT BE VALIDATED FROM THIS REPO. The client spawns the MCP
    // process itself ... so process lifetime is owned by a third-party binary we neither control nor
    // can observe." The same comment's framing (:23-31) is the one to keep in mind while reading the
    // assertions below: the property is a property of the CLIENT, "only the client knows that", and
    // `{ from: "process" }` is valid ONLY because this client runs one server process per chat.
    // Spawning two servers here is the closest this suite can get, and it is a stronger probe than link
    // 4's own leg above, which picks the session id itself -- but it asserts the proxy+hub pair, not
    // the client's spawn policy. Nothing below is evidence for that.
    //
    // Not claimed by this leg, so it is not read as more than it is: no real codex binary is launched
    // (nothing in this file launches a real client), and the project THIS LEG ASSERTS ON is enabled by
    // the operator above rather than by the connect.
    //
    // Corrected with #367: the old wording here said "a terminal-run connect enables no project for
    // EITHER client". That was true when written and is now false -- connect enables the folder it
    // runs in on the terminal path too, because enabling is a device action the hub never required a
    // chat for. The codex connect below passes no `cwd` to runNode, so it inherits the suite's own
    // working directory (the repo) and therefore DOES now enable the repo's project in this test's
    // org, as a side effect of running connect at all.
    //
    // That is harmless today and the suite is green with it: no assertion in this leg counts enabled
    // projects or requires the set to be exactly one. It is recorded rather than left to be
    // rediscovered, because a future assertion that DOES count them would fail here for a reason that
    // has nothing to do with what this leg is testing. If that happens, pass an explicit `cwd` to the
    // runNode call below rather than reverting the connect behaviour.
    //
    // Still true and still the point: codex can never enable a project from a chat.
    const { mintDevice, computerCredential, liveSessions, ProxyProcess } = await import("./helpers/device-hub.js");
    const codexDevice = await mintDevice(hub, operatorKey, "codex");
    const codexHome = tempDir("sprint-codex-machine-");
    const r4b = await runNode(CLI, ["connect", "--hub", hub, "--code", codexDevice.code, "--home", codexHome, "--client", "codex"], childEnv(codexHome));
    expect(r4b.code, `${links(4)} (codex): exit=${r4b.code} err=${JSON.stringify(r4b.err.slice(0, 300))}`).toBe(0);
    expect(computerCredential(codexHome), `${links(4)} (codex): connect must write computer.credential`).toMatch(/^dev_/);

    // The device flow wires codex as a KEYLESS session server: the credential stays in credentials.json
    // and a key in a tool config would mean this path had fallen back to the retired per-tool flow.
    const codexTomlPath = path.join(codexHome, ".codex", "config.toml");
    expect(existsSync(codexTomlPath), `${links(4)} (codex): connect must write ~/.codex/config.toml`).toBe(true);
    const codexToml = readFileSync(codexTomlPath, "utf8");
    expect(codexToml, `${links(4)} (codex): the session server entry is missing`).toContain("[mcp_servers.opencadre-session]");
    expect(codexToml, `${links(4)} (codex): the entry must run the proxy as codex`).toMatch(/opencadre-mcp\.mjs"?\s*,\s*"--client"\s*,\s*"codex"/);
    expect(codexToml, `${links(4)} (codex): the device flow must not put an agent key in a tool config`).not.toMatch(/agt_/);

    const codexProxy = path.join(codexHome, ".opencadre", "bin", "opencadre-mcp.mjs");
    const codexOne = new ProxyProcess(codexProxy, childEnv(codexHome), work, "codex");
    const codexTwo = new ProxyProcess(codexProxy, childEnv(codexHome), work, "codex");
    try {
      await codexOne.initialize();
      await codexTwo.initialize();
      // THESE TWO LINES ARE THE LEG'S TEETH. `initialize()` above is just `request("initialize", ...)`
      // and asserts nothing about its result (tests/helpers/device-hub.ts:178-180), so it cannot fail
      // on a hub that 404s every MCP request. `tools/list` is the first call whose RESULT is asserted,
      // which is why the leg went red here -- and not at initialize -- the one time the harness's hub
      // did not serve /mcp. Trim these two clauses and this leg passes green against a hub that answers
      // no MCP traffic at all, which is the defect it was written to catch.
      expect((await codexOne.request("tools/list", {})).result, `${links(4)} (codex): the installed proxy must get a tool list from the hub`).toBeDefined();
      expect((await codexTwo.request("tools/list", {})).result, `${links(4)} (codex): the second chat's proxy must get one too`).toBeDefined();

      // Read back only THIS device's sessions. The hub lives for the whole file, so a bare list would
      // include every earlier leg's chats and could hand one leg's identity to another's assertion.
      const codexSessions = await liveSessions(hub, operatorKey, codexDevice.deviceId);
      const codexNames = codexSessions.map((s) => s.agentName);
      expect(codexSessions.length, `${links(4)} (codex): two codex chats must register two sessions, got ${JSON.stringify(codexNames)}`).toBe(2);
      expect(new Set(codexNames).size, `${links(4)} (codex): two codex chats must not collapse to one identity (got ${JSON.stringify(codexNames)})`).toBe(2);
      expect(codexSessions.every((s) => s.tool === "codex"), `${links(4)} (codex): both sessions must be attributed to codex, got ${JSON.stringify(codexSessions.map((s) => s.tool))}`).toBe(true);

      // The LABEL family, not just distinctness -- #361's assertion, carried onto names the real proxy
      // minted rather than onto hand-set seats. The distinctness clauses above are decided by a random
      // word (a session's whole name since sessions PR1), so any two distinct names satisfy them,
      // including two sessions that both wear the WRONG client's label: with src/devices.ts clientLabel
      // returning the Claude Code label for every device, the roster would read "(ClaudeCode in ...)"
      // for both and everything above still passes. The label is no longer in the name, so these
      // clauses read it where it now lives, each session's roster line, and go red instead. Both
      // properties are kept, not traded: the seats here are the proxy's own.
      const roster = await codexOne.callTool("get_active_agents");
      for (const s of codexSessions) {
        expect(roster, `${links(4)} (codex): every Codex chat's roster line must carry its client's label, got ${JSON.stringify(roster)}`).toContain(`${s.agentName} (Codex in ${s.projectName}) — `);
      }
      expect(codexNames, `${links(4)} (codex): a Codex chat must not wear a Claude Code chat's identity`).not.toContain(chatOne.body.agentName ?? "");
      expect(roster, `${links(4)}: a Claude Code chat's roster line must carry its client's label`).toContain(`${chatOne.body.agentName} (ClaudeCode in `);
    } finally {
      await codexOne.close();
      await codexTwo.close();
    }

    // ---- LINK 5: they coordinate, and an idle chat is woken by real mail.
    const wakePath = path.join(machineHome, ".opencadre", "bin", "opencadre-wake.mjs");
    expect(existsSync(wakePath), `${links(5)}: the installed wake helper must exist`).toBe(true);
    const stateDir = tempDir("sprint-wake-");

    // Start the watcher BEFORE sending. A watcher started after delivery polls for mail that has
    // already arrived, waits out its whole guard and exits 0 -- which reads exactly like a broken wake
    // feature when nothing is broken.
    const wakeP = new Promise<{ code: number | null; out: string; err: string; exited: boolean }>((resolve) => {
      const child = spawn(process.execPath, [wakePath, "--rewake", "--client", "claude-code"], {
        env: childEnv(machineHome, { OPENCADRE_WAKE_STATE_DIR: stateDir, OPENCADRE_WAIT_SECONDS: "1" }),
        cwd: work,
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "sprint-chat-1", cwd: work }));
      const timer = setTimeout(() => { child.kill(); resolve({ code: null, out, err, exited: false }); }, 20_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, exited: true }); });
    });

    // Wait for the lock: the observable proof it is polling rather than still starting up.
    await waitFor(() => existsSync(stateDir) && readdirSync(stateDir).length > 0, `${links(5)}: the wake helper to take its lock before mail is sent`);

    // Addressed to the identity LINK 4 gave chat-1. Mail to any other agent is correctly ignored -- a
    // wake that fired on someone else's mail would not be coordination.
    const sent = await fetch(`${hub}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${claudeKey}`, "content-type": "application/json" },
      body: JSON.stringify({ toAgent: chatOne.body.agentName, body: "sprint: coordinate with me", priority: "high" }),
    });
    expect(sent.status, links(5)).toBe(201);

    const wake = await wakeP;
    if (!wake.exited || wake.code !== 2) {
      // A silent never-wake has several causes (wrong project, unbound inbox, identity not resolving,
      // mail addressed elsewhere) and they are indistinguishable from the outside. This printout is
      // what turned that ambiguity into a one-run diagnosis when it last happened.
      throw new Error(
        `${links(5)} diagnostics:\n  exited=${wake.exited} code=${wake.code}\n` +
        `  stderr=${JSON.stringify(wake.err.slice(0, 500))}\n  stdout=${JSON.stringify(wake.out.slice(0, 300))}\n` +
        `  mailedTo=${JSON.stringify(chatOne.body.agentName)}\n  project=${JSON.stringify(project["x-opencadre-project"])}\n`,
      );
    }
    expect(wake.err, links(5)).toContain("sprint: coordinate with me");
    expect(wake.err, `${links(5)}: the wake line must never carry the agent key`).not.toContain(claudeKey);
    expect(wake.err, `${links(5)}: the wake line must never carry the machine credential`).not.toContain(deviceCredential);

    // ---- LINK 6: restart the hub; nothing is lost.
    //
    // A real restart: a fresh module graph, so db.ts opens the database file again instead of reusing
    // the handle in memory. Re-opening only the HTTP listener would prove the server can rebind a port
    // and nothing about persistence -- which is the clause actually being tested.
    await new Promise<void>((r) => server.close(() => r()));
    await startHub(true);

    const after = await fetch(`${hub}/v1/messages?peek=true`, {
      headers: { authorization: `Bearer ${deviceCredential}`, "x-opencadre-session": "sprint-chat-1", ...project },
    });
    expect(after.status, `${links(6)}: the machine credential must still serve mail after a restart`).toBe(200);
    const body = (await after.json()) as { messages?: Array<{ body?: string }> };
    expect(
      (body.messages ?? []).some((m) => (m.body ?? "").includes("sprint: coordinate with me")),
      `${links(6)}: the message must survive a restart`,
    ).toBe(true);

    // The identity must survive too: a restart that kept messages but re-minted agents would satisfy a
    // message-only assertion while silently un-identifying every chat on the machine.
    const rejoin = await fetch(`${hub}/v1/sessions/join`, {
      method: "POST", headers: { authorization: `Bearer ${deviceCredential}`, "x-opencadre-session": "sprint-chat-1", ...project },
    });
    expect([200, 201], `${links(6)}: the session must still resolve after a restart`).toContain(rejoin.status);
    expect(((await rejoin.json()) as { agentName?: string }).agentName, `${links(6)}: a chat must keep its identity across a restart`).toBe(chatOne.body.agentName);
  });
});
