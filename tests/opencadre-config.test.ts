import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { originUrl, projectHeaders, projectIdentity, readDeviceCredential, resolveHub } from "../scripts/opencadre-config.mjs";

const noEnv = { OPENCADRE_URL: "", OPENCADRE_KEY: "" };
const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-config-"));

function writeClaude(home: string, config: object) {
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify(config));
}
const claudeServer = (url: string, key: string) => ({ opencadre: { type: "http", url, headers: { Authorization: `Bearer ${key}` } } });

function writeCodex(home: string, url: string, key: string) {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), [
    "[mcp_servers.other]",
    'url = "http://other/mcp"',
    'http_headers = { Authorization = "Bearer agt_other" }',
    "[mcp_servers.opencadre]",
    `url = "${url}"`,
    `http_headers = { Authorization = "Bearer ${key}" }`,
    "[features]",
    "hooks = true",
  ].join("\n"));
}

function writeAntigravity(home: string, server: object, sub = "config") {
  mkdirSync(path.join(home, ".gemini", sub), { recursive: true });
  writeFileSync(path.join(home, ".gemini", sub, "mcp_config.json"), JSON.stringify({ mcpServers: { opencadre: server } }));
}

describe("resolveHub", () => {
  it("prefers OPENCADRE_URL + OPENCADRE_KEY over every client config", () => {
    const home = tempHome();
    writeClaude(home, { mcpServers: claudeServer("http://claude/mcp", "agt_claude") });
    writeCodex(home, "http://codex/mcp", "agt_codex");
    writeAntigravity(home, { serverUrl: "http://ag/mcp", headers: { Authorization: "Bearer agt_ag" } });
    const env = { OPENCADRE_URL: "http://env/", OPENCADRE_KEY: "agt_env" };
    for (const client of [undefined, "claude-code", "codex", "antigravity"]) {
      expect(resolveHub({ client, home, env })).toEqual({ base: "http://env", key: "agt_env", source: "env", headers: {} });
    }
  });

  it("reads Claude Code's ~/.claude.json: the project matching cwd, then user scope", () => {
    const home = tempHome();
    writeClaude(home, {
      mcpServers: claudeServer("http://user/mcp", "agt_user"),
      projects: { "C:/elsewhere": { mcpServers: claudeServer("http://else/mcp", "agt_else") }, [process.cwd()]: { mcpServers: claudeServer("http://proj/mcp/", "agt_proj") } },
    });
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: process.cwd() })).toEqual({ base: "http://proj", key: "agt_proj", source: "claude-code", headers: {} });
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: path.join(tmpdir(), "nowhere") })).toMatchObject({ key: "agt_user" });
  });

  it("never lends one project's Claude Code agent to an unrelated project; a subfolder uses its parent's", () => {
    // Found live: with no user-wide agent, a session in an unrelated project (Sidecar) picked up the OpenCadre
    // folder's agent, so its Stop hook read and answered that agent's mail.
    const home = tempHome();
    const project = path.join(tmpdir(), "oc-project");
    writeClaude(home, { projects: { [project]: { mcpServers: claudeServer("http://proj/mcp", "agt_proj") } } });
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: path.join(tmpdir(), "unrelated-project") })).toEqual({});
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: `${project}-sibling` })).toEqual({});
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: path.join(project, "src", "deep") })).toMatchObject({ key: "agt_proj" });

    // The nearest enclosing folder wins over an outer one.
    writeClaude(home, {
      projects: {
        [project]: { mcpServers: claudeServer("http://outer/mcp", "agt_outer") },
        [path.join(project, "packages", "app")]: { mcpServers: claudeServer("http://inner/mcp", "agt_inner") },
      },
    });
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: path.join(project, "packages", "app", "lib") })).toMatchObject({ key: "agt_inner" });
    expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: path.join(project, "docs") })).toMatchObject({ key: "agt_outer" });
  });

  it("reads Codex's [mcp_servers.opencadre] table, not a neighbouring server", () => {
    const home = tempHome();
    writeCodex(home, "http://codex/mcp", "agt_codex");
    expect(resolveHub({ client: "codex", home, env: noEnv })).toEqual({ base: "http://codex", key: "agt_codex", source: "codex", headers: {} });
  });

  it("reads Antigravity's mcp_config.json (serverUrl or url), defaulting to the public hub", () => {
    const home = tempHome();
    writeAntigravity(home, { serverUrl: "http://ag/mcp", headers: { Authorization: "Bearer agt_ag" } });
    expect(resolveHub({ client: "antigravity", home, env: noEnv })).toEqual({ base: "http://ag", key: "agt_ag", source: "antigravity", headers: {} });

    const cfgHome = tempHome();
    writeAntigravity(cfgHome, { headers: { authorization: "Bearer agt_cfg" } }, "config");
    expect(resolveHub({ client: "antigravity", home: cfgHome, env: noEnv })).toEqual({ base: "https://hub.opencadre.example", key: "agt_cfg", source: "antigravity", headers: {} });
  });

  it("with no client, keeps the legacy order: env, then Antigravity", () => {
    const home = tempHome();
    writeClaude(home, { mcpServers: claudeServer("http://claude/mcp", "agt_claude") });
    writeCodex(home, "http://codex/mcp", "agt_codex");
    expect(resolveHub({ home, env: noEnv })).toEqual({});
    writeAntigravity(home, { url: "http://ag/mcp", headers: { Authorization: "Bearer agt_ag" } });
    expect(resolveHub({ home, env: noEnv })).toMatchObject({ key: "agt_ag", source: "antigravity" });
  });

  it("tries a list of clients in order", () => {
    const home = tempHome();
    writeClaude(home, { mcpServers: claudeServer("http://claude/mcp", "agt_claude") });
    expect(resolveHub({ client: ["codex", "claude-code"], home, env: noEnv })).toMatchObject({ key: "agt_claude" });
    writeCodex(home, "http://codex/mcp", "agt_codex");
    expect(resolveHub({ client: ["codex", "claude-code"], home, env: noEnv })).toMatchObject({ key: "agt_codex" });
  });

  it("never returns a key from another client's config", () => {
    const home = tempHome();
    writeCodex(home, "http://codex/mcp", "agt_codex");
    writeAntigravity(home, { serverUrl: "http://ag/mcp", headers: { Authorization: "Bearer agt_ag" } });
    expect(resolveHub({ client: "claude-code", home, env: noEnv })).toEqual({});
    expect(resolveHub({ client: "nonsense", home, env: noEnv })).toEqual({});

    const claudeOnly = tempHome();
    writeClaude(claudeOnly, { mcpServers: claudeServer("http://claude/mcp", "agt_claude") });
    expect(resolveHub({ client: "codex", home: claudeOnly, env: noEnv })).toEqual({});
    expect(resolveHub({ client: "antigravity", home: claudeOnly, env: noEnv })).toEqual({});
  });

  it("a key without a URL targets the public hub once no config matches", () => {
    expect(resolveHub({ client: "claude-code", home: tempHome(), env: { OPENCADRE_KEY: "agt_env" } })).toEqual({ base: "https://hub.opencadre.example", key: "agt_env", source: "env", headers: {} });
  });

  // The doctor's per-client rows are a SECOND table over the same clients, so they can drift from
  // the registry exactly the way the three original lists drifted from each other — which is the
  // history this file exists to record. A client present in the registry and absent from
  // DOCTOR_CHECKS would make `doctor --client <it>` report nothing at all, and silence reads as a
  // pass. Pin coverage in both directions rather than trusting the two to stay in step.
  it("every registry client has a doctor row, and no doctor row is a stranger", async () => {
    const { CLIENT_NAMES, DOCTOR_CHECKS, MEASURING_CLIENTS: MEASURING, COMPUTER_TOOLS: TOOLS } = await import("../scripts/opencadre-clients.mjs");
    const doctorNames = Object.keys(DOCTOR_CHECKS);
    // No client is invisible to doctor...
    expect(CLIENT_NAMES.filter((n: string) => !doctorNames.includes(n))).toEqual([]);
    // ...and doctor invents no client the registry does not have.
    expect(doctorNames.filter((n: string) => !CLIENT_NAMES.includes(n))).toEqual([]);
    // A measuring client is not served, so it can declare no checks. This is the one place the two
    // tables MUST agree, because "measuring" is exactly the reason a check cannot exist yet.
    for (const name of MEASURING) {
      expect({ name, served: DOCTOR_CHECKS[name].served }).toEqual({ name, served: false });
      expect(DOCTOR_CHECKS[name].checks).toEqual([]);
    }
    // AND THE REVERSE, which is the assertion that actually bites: a SERVED client that declares no
    // checks would make `doctor --client <it>` print nothing to check and report a verdict computed
    // from nothing. Coverage of the NAME is not coverage of the WORK — mutation-testing this file
    // showed the first version of this test stayed green when a served client's checks were emptied,
    // which is the same silent-no-report shape the row exists to prevent.
    for (const name of TOOLS) {
      expect({ name, hasChecks: DOCTOR_CHECKS[name].checks.length > 0 }).toEqual({ name, hasChecks: true });
    }
  });

  // These three lists used to be hand-maintained in two files, each telling the reader to "keep in step"
  // with the other. They drifted. The values are pinned here so a future edit to one view cannot quietly
  // change another, and so the CLI's usage text and error messages keep the order users already see.
  it("derives every client list from one table, unchanged", async () => {
    const { CLIENT_NAMES, COMPUTER_TOOLS: TOOLS, MEASURING_CLIENTS: MEASURING, READER_NAMES } = await import("../scripts/opencadre-clients.mjs");
    expect(READER_NAMES).toEqual(["claude-code", "codex", "cursor", "gemini", "qwen", "windsurf", "copilot", "antigravity", "reasonix"]);
    expect(TOOLS).toEqual(["claude-code", "codex", "dsh", "cursor", "gemini", "qwen", "amp", "cline", "kilo", "windsurf", "copilot", "goose", "antigravity", "devin", "droid", "vibe", "crush", "grok", "opencode"]);
    expect(MEASURING).toEqual(["reasonix"]);
    // CLIENT_NAMES is the table's own declaration order, not TOOLS-then-MEASURING: opencode is declared
    // last in the table even though it is now served, so the two orders are NOT the same list any more.
    expect(CLIENT_NAMES).toEqual([...TOOLS, "reasonix"]);
  });

  // The views are filters over one table, so they cannot disagree with each other. What they can still do is
  // LOSE a row: a client with no reader, not a computer tool and not measuring appears in none of the three,
  // so the runtime, the CLI and connect would all treat it as though it did not exist. Pin the shape instead.
  it("no client row is invisible to every list", async () => {
    const { CLIENT_NAMES, COMPUTER_TOOLS: TOOLS, MEASURING_CLIENTS: MEASURING, READER_NAMES } = await import("../scripts/opencadre-clients.mjs");
    const seen = new Set([...TOOLS, ...MEASURING, ...READER_NAMES]);
    expect(CLIENT_NAMES.filter((name: string) => !seen.has(name))).toEqual([]);
    // A client cannot be both set up today and still being measured, and a computer tool must agree with itself.
    expect(TOOLS.filter((name: string) => MEASURING.includes(name))).toEqual([]);
    expect(TOOLS).toEqual(["claude-code", "codex", "dsh", "cursor", "gemini", "qwen", "amp", "cline", "kilo", "windsurf", "copilot", "goose", "antigravity", "devin", "droid", "vibe", "crush", "grok", "opencode"]);
    expect(READER_NAMES).toEqual(["claude-code", "codex", "cursor", "gemini", "qwen", "windsurf", "copilot", "antigravity", "reasonix"]);
  });

  // Pinning the derived lists is not enough on its own: it shows the views agree with each other, not that a
  // client's own row still says what it said. A row quietly flipped to device:false drops a tool out of the
  // set a computer credential serves - a capability change - while every view stays internally consistent.
  // Pin the flags themselves, which is what the drift collapse is actually about.
  //
  // This asserts the whole set, so: flipping any row's device/measuring/reader flag fails it, and ADDING a
  // client row fails it until the expectation below is updated deliberately. Adding a new FIELD to a row
  // (increment 2's session strategy) does not fail it - that is intended, since a field is not a capability.
  it("every client row declares the same capability it did before the collapse", async () => {
    const { CLIENT_NAMES, COMPUTER_TOOLS: TOOLS, MEASURING_CLIENTS: MEASURING, READER_NAMES } = await import("../scripts/opencadre-clients.mjs");
    const capability = Object.fromEntries(
      CLIENT_NAMES.map((name: string) => [name, { device: TOOLS.includes(name), measuring: MEASURING.includes(name), reader: READER_NAMES.includes(name) }]),
    );
    // reasonix is the deliberate addition described in the note above - a reader exists, so it is a named
    // agent, but nothing can serve it a computer credential yet (device:false) and no session-id source has
    // been OBSERVED for it, so it stays measuring. This expectation is updated with that row, not drifted.
    expect(capability).toEqual({
      "claude-code": { device: true, measuring: false, reader: true },
      codex: { device: true, measuring: false, reader: true },
      // Served by a hook rather than a config reader: DSH has no config file to read a key out of,
      // so it declares no reader while still being a computer tool. Added deliberately with unit 2
      // (#207) - this expectation failing on a NEW row is the guard working as designed.
      dsh: { device: true, measuring: false, reader: false },
      // Cursor joined the served set with the signed per-call stamp (`{ from: "stamp" }`,
      // docs/design/HARNESS-CURSOR-LOCAL.md §11). No reader: connect installs the local proxy.
      cursor: { device: true, measuring: false, reader: true },
      // Antigravity: served by the conversation id agy puts on every MCP call (`_meta`), measured live on agy 1.2.9.
      antigravity: { device: true, measuring: false, reader: true },
      // Gemini CLI: served by the stamp too (docs/design/HARNESS-GEMINI.md); its reader finds a named agent.
      gemini: { device: true, measuring: false, reader: true },
      // Devin CLI: MCP servers shared per process; each call stamped by its PreToolUse hook (measured on 3000.6.11).
      devin: { device: true, measuring: false, reader: false },
      droid: { device: true, measuring: false, reader: false },
      vibe: { device: true, measuring: false, reader: false },
      crush: { device: true, measuring: false, reader: false },
      // Grok Build: GROK_SESSION_ID in each session's MCP child (measured on 1.0.41).
      grok: { device: true, measuring: false, reader: false },
      // OpenCode joined the served set with the measured per-call id (`{ from: "call" }`, source of the
      // id in docs/design/HARNESS-OPENCODE-IDENTITY.md). It has no reader: connect installs the local
      // proxy rather than reading a key back out of OpenCode's config.
      opencode: { device: true, measuring: false, reader: false },
      // Qwen Code: identity from QWEN_CODE_SESSION_ID, handed to the hooks through the host handoff; its reader finds a
      // named agent in ~/.qwen/settings.json (review of 14c8f9a, should-fix 2).
      qwen: { device: true, measuring: false, reader: true },
      // Amp: served by the stamp, signed by OpenCadre's Amp plugin with the thread id (examples/hooks/opencadre-amp-plugin.mjs).
      amp: { device: true, measuring: false, reader: false },
      // Kilo Code's CLI: served by the stamp, signed by OpenCadre's Kilo plugin with the session id (examples/hooks/opencadre-kilo-core.mjs).
      kilo: { device: true, measuring: false, reader: false },
      // Cline's CLI: served by the stamp, signed by its PreToolUse file hook with the root session id.
      cline: { device: true, measuring: false, reader: false },
      // Goose: AGENT_SESSION_ID per session's extension, with `_meta["agent-session-id"]` per call.
      goose: { device: true, measuring: false, reader: false },
      // Copilot CLI: COPILOT_AGENT_SESSION_ID per session's server, a signed `_meta` stamp per call; a named-agent reader.
      copilot: { device: true, measuring: false, reader: true },
      // Windsurf: clearance only (its hooks read no JSON); its reader finds a named agent for OpenCadre's tools.
      windsurf: { device: true, measuring: false, reader: true },
      reasonix: { device: false, measuring: true, reader: true },
    });
  });

  it("the CLI and the runtime agree on which tools a computer credential serves", async () => {
    const { COMPUTER_TOOLS } = await import("../scripts/opencadre-config.mjs");
    const { DEVICE_CLIENTS, MEASURING_CLIENTS } = await import("../cli/lib/device.mjs");
    expect(DEVICE_CLIENTS).toEqual(COMPUTER_TOOLS);
    expect(DEVICE_CLIENTS).toEqual(["claude-code", "codex", "dsh", "cursor", "gemini", "qwen", "amp", "cline", "kilo", "windsurf", "copilot", "goose", "antigravity", "devin", "droid", "vibe", "crush", "grok", "opencode"]);
    expect(MEASURING_CLIENTS).toEqual(["reasonix"]);
  });

  // The table in scripts/opencadre-clients.mjs and cli/lib/clients.mjs are two lists that MUST agree,
  // and nothing used to check it. `detectClients` filters its own CLIENTS array through a `present`
  // lookup table, so a name in CLIENTS with no predicate throws `TypeError: present[client] is not
  // a function` - but ONLY once the filter actually reaches it, i.e. only for a user whose earlier
  // entries all miss. On a fresh machine that is every user, so adding the grok row without its
  // predicate is a one-line change that breaks `connect` for people who do not have Grok installed.
  // Asserting list membership would NOT catch that; only calling detectClients does.
  //
  // The invariant is deliberately not "every table client appears in CLIENTS". `dsh` does not, and
  // must not: it has no user-facing config file or binary to look for, so auto-detection can never
  // find it, and it is reached only by an explicit `--client dsh`. Requiring a predicate for it
  // would force a fake one.
  it("detectClients has a predicate for every client it might be asked look for", async () => {
    const { detectClients } = await import("../cli/lib/clients.mjs");
    // A home with none of the clients present, and an empty PATH, so every predicate is evaluated
    // and each must return false rather than blow up.
    const emptyHome = mkdtempSync(path.join(tmpdir(), "oc-detect-none-"));
    expect(() => detectClients(emptyHome, { PATH: "" })).not.toThrow();
    expect(detectClients(emptyHome, { PATH: "" })).toEqual([]);
  });

  // The other direction: detectClients would look for a client no list serves, so `connect --client`
  // could accept a name the runtime has no row for. Both directions are one assertion each because
  // the failure is silent in whichever direction is unchecked.
  it("every client the machine detection knows is also in the table", async () => {
    const { CLIENT_NAMES } = await import("../scripts/opencadre-clients.mjs");
    const { CLIENTS } = await import("../cli/lib/clients.mjs");
    expect(CLIENTS.filter((name: string) => !CLIENT_NAMES.includes(name))).toEqual([]);
  });

  describe("device credentials (per-session identity)", () => {
    const credential = `dev_${"ab".repeat(24)}`;
    function writeDevice(home: string, client = "claude-code") {
      mkdirSync(path.join(home, ".opencadre"), { recursive: true });
      writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ devices: { [client]: { hub: "http://dev-hub/", credential, deviceId: "d1" } } }));
    }
    // A folder inside a git checkout named "Acme": the project header is the git root's name, not the subfolder's.
    function checkout() {
      const root = path.join(tempHome(), "Acme");
      mkdirSync(path.join(root, ".git"), { recursive: true });
      mkdirSync(path.join(root, "src", "deep"), { recursive: true });
      return { root, deep: path.join(root, "src", "deep") };
    }

    it("CLAUDE_CODE_HOST_SESSION_ID names the host chat for Claude Code only, never for a tool whose hooks merely inherited it", () => {
      // A Copilot, Windsurf or Kilo hook started from a shell inside a Claude Code chat inherits the variable; taking it
      // would file that tool's session under the Claude chat's host (fixed in 3a8a89e).
      const env = { ...noEnv, CLAUDE_CODE_HOST_SESSION_ID: "claude-host-1" };
      const { deep } = checkout();
      for (const client of ["copilot", "windsurf", "kilo", "codex"]) {
        const home = tempHome();
        writeDevice(home, client);
        const headers = resolveHub({ client, home, env, cwd: deep, sessionId: "their-own" }).headers ?? {};
        expect(headers["x-opencadre-session"], client).toBe("their-own");
        expect(headers["x-opencadre-host-session"], client).toBeUndefined();
      }
      const home = tempHome();
      writeDevice(home);
      expect(resolveHub({ client: "claude-code", home, env, cwd: deep, sessionId: "tool-1" }).headers?.["x-opencadre-host-session"]).toBe("claude-host-1");
    });

    it("resolves only when the session is known, from the argument or CLAUDE_CODE_SESSION_ID", () => {
      const home = tempHome();
      writeDevice(home);
      const { deep } = checkout();
      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: deep })).toEqual({});
      expect(resolveHub({ client: "claude-code", home, env: { ...noEnv, CLAUDE_CODE_SESSION_ID: "  " }, cwd: deep })).toEqual({});
      // A malformed id is never repaired into some other session's id.
      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: deep, sessionId: "has space" })).toEqual({});

      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: deep, sessionId: "sess-A" })).toEqual({
        base: "http://dev-hub",
        key: credential,
        source: "device",
        // Resolve-only by default: a hook never creates a session.
        headers: {
          "x-opencadre-session": "sess-A", "x-opencadre-client": "claude-code", "x-opencadre-project": "local:acme", "x-opencadre-project-name": "Acme",
          "x-opencadre-resolve-only": "1",
        },
      });
      const fromEnv = resolveHub({ client: "claude-code", home, env: { ...noEnv, CLAUDE_CODE_SESSION_ID: "sess-B", CLAUDE_CODE_HOST_SESSION_ID: "host-1" }, cwd: deep, create: true });
      // Only a creator (the connect-time join, a session command) opts out.
      expect(fromEnv.headers).toEqual({
        "x-opencadre-session": "sess-B", "x-opencadre-host-session": "host-1", "x-opencadre-client": "claude-code", "x-opencadre-project": "local:acme", "x-opencadre-project-name": "Acme",
      });
      // The hook's own session_id wins over an inherited env value.
      expect(resolveHub({ client: "claude-code", home, env: { ...noEnv, CLAUDE_CODE_SESSION_ID: "sess-B" }, cwd: deep, sessionId: "sess-A" }).headers).toMatchObject({ "x-opencadre-session": "sess-A" });
    });

    it("a named agent for the folder, user-wide or env wins over the device credential", () => {
      const home = tempHome();
      writeDevice(home);
      const { root, deep } = checkout();
      writeClaude(home, { projects: { [root]: { mcpServers: claudeServer("http://proj/mcp", "agt_proj") } } });
      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: deep, sessionId: "sess-A" })).toEqual({ base: "http://proj", key: "agt_proj", source: "claude-code", headers: {} });
      // Outside that folder the device applies again.
      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: tempHome(), sessionId: "sess-A" })).toMatchObject({ source: "device" });

      writeClaude(home, { mcpServers: claudeServer("http://user/mcp", "agt_user") });
      expect(resolveHub({ client: "claude-code", home, env: noEnv, cwd: tempHome(), sessionId: "sess-A" })).toMatchObject({ key: "agt_user", headers: {} });
      expect(resolveHub({ client: "claude-code", home, env: { OPENCADRE_URL: "http://env", OPENCADRE_KEY: "agt_env" }, sessionId: "sess-A" })).toMatchObject({ key: "agt_env", headers: {} });
    });

    it("never lends one client's device credential to another client, and ignores a non-device value", () => {
      const home = tempHome();
      writeDevice(home, "claude-code");
      expect(resolveHub({ client: "codex", home, env: noEnv, sessionId: "sess-A" })).toEqual({});
      expect(resolveHub({ home, env: noEnv, sessionId: "sess-A" })).toEqual({});
      writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ devices: { "claude-code": { hub: "http://dev-hub", credential: "agt_not_a_device" } } }));
      expect(resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "sess-A" })).toEqual({});
      writeFileSync(path.join(home, ".opencadre", "credentials.json"), "{ not json");
      expect(resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "sess-A" })).toEqual({});
    });
  });

  describe("one credential per computer", () => {
    const computerCredential = `dev_${"cd".repeat(24)}`;
    const oldCredential = `dev_${"ef".repeat(24)}`;
    const writeCredentials = (home: string, content: object) => {
      mkdirSync(path.join(home, ".opencadre"), { recursive: true });
      writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify(content));
    };

    it("serves Claude Code and Codex from { computer }, and never a tool the computer doesn't set up", () => {
      const home = tempHome();
      writeCredentials(home, { computer: { hub: "http://computer-hub/", credential: computerCredential, deviceId: "c1" } });
      expect(readDeviceCredential({ client: "claude-code", home, env: noEnv })).toEqual({ hub: "http://computer-hub", credential: computerCredential, deviceId: "c1" });
      expect(readDeviceCredential({ client: "codex", home, env: noEnv })).toEqual({ hub: "http://computer-hub", credential: computerCredential, deviceId: "c1" });
      for (const client of ["reasonix"]) expect(readDeviceCredential({ client, home, env: noEnv })).toBeNull();
      // Cursor is a computer tool now, served by the same credential.
      expect(readDeviceCredential({ client: "cursor", home, env: noEnv })).toEqual({ hub: "http://computer-hub", credential: computerCredential, deviceId: "c1" });
      expect(resolveHub({ client: "codex", home, env: noEnv, sessionId: "codex-sess", cwd: tempHome() })).toMatchObject({ source: "device", key: computerCredential, headers: { "x-opencadre-client": "codex" } });
      // With no client named, a session id is not honoured for any client (the wake script names Antigravity itself).
      expect(resolveHub({ home, env: noEnv, sessionId: "sess-A" })).toEqual({});
      expect(resolveHub({ client: "antigravity", home, env: noEnv, sessionId: "sess-A", cwd: tempHome() })).toMatchObject({ source: "device", headers: { "x-opencadre-client": "antigravity", "x-opencadre-session": "sess-A" } });
    });

    it("still resolves today's per-tool shape for that tool, and prefers the computer entry once both exist", () => {
      const home = tempHome();
      writeCredentials(home, { devices: { "claude-code": { hub: "http://old-hub", credential: oldCredential, deviceId: "old" } } });
      expect(readDeviceCredential({ client: "claude-code", home, env: noEnv })).toEqual({ hub: "http://old-hub", credential: oldCredential, deviceId: "old" });
      expect(resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "sess-A", cwd: tempHome() })).toMatchObject({ source: "device", key: oldCredential });
      expect(readDeviceCredential({ client: "codex", home, env: noEnv })).toBeNull();

      writeCredentials(home, { devices: { "claude-code": { hub: "http://old-hub", credential: oldCredential } }, computer: { hub: "http://computer-hub", credential: computerCredential } });
      expect(readDeviceCredential({ client: "claude-code", home, env: noEnv })?.credential).toBe(computerCredential);
      // A malformed computer entry falls back to the tool's own entry rather than to nothing.
      writeCredentials(home, { devices: { "claude-code": { hub: "http://old-hub", credential: oldCredential } }, computer: { hub: "http://computer-hub", credential: "agt_nope" } });
      expect(readDeviceCredential({ client: "claude-code", home, env: noEnv })?.credential).toBe(oldCredential);
    });
  });

  describe("project identity: a project is a git repository", () => {
    const repo = (name: string, remote?: string) => {
      const root = path.join(tempHome(), name);
      mkdirSync(path.join(root, ".git"), { recursive: true });
      mkdirSync(path.join(root, "src"), { recursive: true });
      const config = ["[core]", "\trepositoryformatversion = 0", '[remote "upstream"]', "\turl = https://github.com/someone-else/fork.git"];
      if (remote) config.push('[remote "origin"]', `\turl = ${remote}`, "\tfetch = +refs/heads/*:refs/remotes/origin/*");
      writeFileSync(path.join(root, ".git", "config"), `${config.join("\n")}\n`);
      return root;
    };

    it("gives the same key for the same remote in two differently named folders, from any subfolder", () => {
      const one = repo("OpenCadre", "git@github.com:mabdullah4800-ai/OpenCadre.git");
      const two = repo("oc-checkout-2", "https://github.com/mabdullah4800-ai/opencadre");
      expect(projectIdentity(path.join(one, "src"))).toEqual({ key: "github.com/mabdullah4800-ai/opencadre", name: "OpenCadre" });
      expect(projectIdentity(two)).toEqual({ key: "github.com/mabdullah4800-ai/opencadre", name: "opencadre" });
      expect(projectHeaders(two)).toEqual({ "x-opencadre-project": "github.com/mabdullah4800-ai/opencadre", "x-opencadre-project-name": "opencadre" });
    });

    it("falls back to local:<folder> with no origin remote, outside a checkout, or for a remote that isn't host/owner/repo", () => {
      expect(projectIdentity(path.join(repo("No Remote!"), "src"))).toEqual({ key: "local:no-remote", name: "No-Remote" });
      const plain = path.join(tempHome(), "PlainFolder");
      mkdirSync(plain);
      expect(projectIdentity(plain)).toEqual({ key: "local:plainfolder", name: "PlainFolder" });
      expect(projectIdentity(repo("PathRemote", "C:/repos/bare.git"))).toEqual({ key: "local:pathremote", name: "PathRemote" });
    });

    it("gives one local: key for one folder however Windows spells its case", () => {
      // Windows hands a process whatever casing its launcher used, and both spellings of the same
      // folder occur in practice (desktop\opencadre and Desktop\OpenCadre). A key that tracks case
      // makes them two projects: the cursor is discarded and every unread message re-wakes the session.
      const upper = repo("CaseProj");
      const lower = repo("caseproj");
      const upperKey = projectIdentity(upper).key;
      const lowerKey = projectIdentity(lower).key;
      expect(upperKey).toBe("local:caseproj");
      expect(lowerKey).toBe(upperKey);
    });

    it("follows a worktree's .git file to the shared repository's config, without spawning git", () => {
      const main = repo("MainCheckout", "ssh://git@gitlab.example.com:2222/Team/App.git");
      const gitDir = path.join(main, ".git", "worktrees", "feature");
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(path.join(gitDir, "commondir"), "../..\n");
      const worktree = path.join(tempHome(), "feature-worktree");
      mkdirSync(path.join(worktree, "lib"), { recursive: true });
      writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      expect(projectIdentity(path.join(worktree, "lib"))).toEqual({ key: "gitlab.example.com/team/app", name: "App" });
    });

    it("reads only origin's url from the config", () => {
      expect(originUrl('[remote "origin"]\n\turl = "https://h.example/o/r.git" ; comment\n[remote "origin2"]\n\turl = x')).toBe("https://h.example/o/r.git");
      expect(originUrl('[Remote "Origin"]\n\turl = https://h.example/o/r')).toBeUndefined();
      expect(originUrl('[REMOTE "origin"]\n\tURL = https://h.example/o/r')).toBe("https://h.example/o/r");
      expect(originUrl("")).toBeUndefined();
    });
  });

  it("uses OPENCADRE_HOOK_HOME when no home is given", () => {
    const home = tempHome();
    writeCodex(home, "http://codex/mcp", "agt_codex");
    expect(resolveHub({ client: "codex", env: { ...noEnv, OPENCADRE_HOOK_HOME: home } })).toMatchObject({ key: "agt_codex" });
  });

  // Reasonix REWRITES its own config into canonical form on load: an inline
  // `headers = { Authorization = "Bearer …" }` becomes a `[plugins.headers]` SUB-table. A reader that
  // ends a [[plugins]] block at the next line starting with "[" therefore stops AT that sub-table,
  // never sees the Authorization line, and returns null - so the client looks unconfigured while its
  // config says otherwise. A green suite missed exactly this, because it only ever wrote the inline
  // form by hand. Both spellings are pinned here, and so is the block boundary that caused it.
  describe("the reasonix reader reads the format Reasonix actually writes", () => {
    const reasonixCwd = (toml: string) => {
      const dir = tempHome();
      writeFileSync(path.join(dir, "reasonix.toml"), toml);
      return dir;
    };

    it("returns a VALUE for the canonical [plugins.headers] sub-table, not zero bytes", () => {
      const cwd = reasonixCwd([
        "[[plugins]]",
        '  name = "opencadre"',
        '  type = "http"',
        '  url = "http://canonical/mcp"',
        "  [plugins.headers]",
        '    Authorization = "Bearer agt_canonical"',
      ].join("\n"));
      expect(resolveHub({ client: "reasonix", home: tempHome(), env: noEnv, cwd })).toEqual({
        base: "http://canonical", key: "agt_canonical", source: "reasonix", headers: {},
      });
    });

    it("still reads the inline header form a hand-written or generated file uses", () => {
      const cwd = reasonixCwd([
        "[[plugins]]",
        'name    = "opencadre"',
        'type    = "http"',
        'url     = "http://inline/mcp"',
        'headers = { Authorization = "Bearer agt_inline" }',
      ].join("\n"));
      expect(resolveHub({ client: "reasonix", home: tempHome(), env: noEnv, cwd }))
        .toMatchObject({ base: "http://inline", key: "agt_inline", source: "reasonix" });
    });

    // The boundary rule that fixes the above must not over-reach: a [plugins.headers] sub-table
    // belongs to the plugin it follows. Reading one that belongs to a NEIGHBOUR would hand this
    // client another plugin's key - the misattribution every reader here exists to prevent.
    it("takes opencadre's own sub-table, never a neighbouring plugin's", () => {
      const cwd = reasonixCwd([
        "[[plugins]]",
        '  name = "somethingelse"',
        '  url = "http://other/mcp"',
        "  [plugins.headers]",
        '    Authorization = "Bearer agt_other"',
        "[[plugins]]",
        '  name = "opencadre"',
        '  url = "http://theirs/mcp"',
        "  [plugins.headers]",
        '    Authorization = "Bearer agt_theirs"',
      ].join("\n"));
      expect(resolveHub({ client: "reasonix", home: tempHome(), env: noEnv, cwd }))
        .toMatchObject({ base: "http://theirs", key: "agt_theirs" });
    });

    // The SAME neighbour document, INDENTED - and it has to be a separate arm, because the arm above
    // is written flush and passed against a boundary rule that was anchored at column 0. The entry
    // matcher accepts an indented `[[plugins]]`, so a boundary rule that does not is disagreeing with
    // it: the block never ends at the indented neighbour, runs on to the opencadre entry, and the
    // url/Bearer lookups return the FIRST ones in the joined block. Measured on these bytes - the
    // column-0 rule returned {"url":"http://other/mcp","key":"agt_other"}, i.e. the neighbour's
    // identity, which is what this reader exists to prevent.
    it("does not swallow an INDENTED neighbouring plugin", () => {
      const cwd = reasonixCwd([
        "[[plugins]]",
        '  name = "somethingelse"',
        '  url = "http://other/mcp"',
        "  [plugins.headers]",
        '    Authorization = "Bearer agt_other"',
        "",
        "  [[plugins]]",
        '    name = "opencadre"',
        '    url = "http://theirs/mcp"',
        "    [plugins.headers]",
        '      Authorization = "Bearer agt_theirs"',
      ].join("\n"));
      expect(resolveHub({ client: "reasonix", home: tempHome(), env: noEnv, cwd }))
        .toMatchObject({ base: "http://theirs", key: "agt_theirs" });
    });
  });
});
