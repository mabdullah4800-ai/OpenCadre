import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLIENTS, clientConfigFile, detectClients, hasConfigWriter, planClientConfig, readExistingServer } from "../cli/lib/clients.mjs";
import { planOpencodeSessionServer, sessionServerArgs } from "../cli/lib/device.mjs";
import { tmpDir } from "./helpers/tmp.js";

// OpenCode support: detection, and the MCP config writer that merges one `opencadre`
// entry into the `mcp.servers` object of ~/.config/opencode/opencode.json (global config).
//
// MEASURED against the installed binary (opencode v2.0.10) on 2026-09-19 - see
// docs/design/HARNESS-OPENCODE-IDENTITY.md. The docs were NOT trusted over the binary:
//   - global config: ~/.config/opencode/opencode.json (JSON or JSONC)
//   - remote MCP entry: mcp.servers.<name> { type: "remote", url, headers }
//   - v2 does NOT read a name placed directly under `mcp`. The flat `mcp.<name>` shape
//     makes `opencode mcp list` answer "No MCP servers configured" (measured), so the
//     nesting below is load-bearing, not cosmetic.
//   - v2 spells absence as `disabled: true`; a connected server omits the field, so the
//     writer no longer emits `enabled` (which v2 ignores).

const tempHome = () => tmpDir("oc-opencode-home-");
const HOME_WITH_CONFIG = () => {
  const home = tempHome();
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  return home;
};

describe("opencode detection", () => {
  it("is in the client list so connect can be told to look for it", () => {
    expect(CLIENTS).toContain("opencode");
  });

  it("is present when its global config directory exists", () => {
    const home = HOME_WITH_CONFIG();
    // Empty PATH: the folder, not a binary, is what makes it present.
    expect(detectClients(home, { PATH: "" })).toContain("opencode");
  });

  it("is present when the opencode binary is on PATH", () => {
    const home = tempHome();
    const bin = mkdtempSync(path.join(tmpdir(), "oc-opencode-bin-"));
    writeFileSync(path.join(bin, process.platform === "win32" ? "opencode.exe" : "opencode"), "");
    expect(detectClients(home, { PATH: bin })).toContain("opencode");
  });

  it("is absent when neither the config directory nor the binary is there", () => {
    const home = tempHome();
    expect(detectClients(home, { PATH: "" })).not.toContain("opencode");
  });
});

describe("opencode config writer", () => {
  it("has a writer, so connect will offer to set it up rather than refuse it", () => {
    expect(hasConfigWriter("opencode")).toBe(true);
  });

  it("points at the global ~/.config/opencode/opencode.json", () => {
    expect(clientConfigFile("/home/x", "opencode")).toBe(path.join("/home/x", ".config", "opencode", "opencode.json"));
  });

  it("writes a remote MCP entry into a fresh file", () => {
    const home = tempHome();
    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" });
    expect(plan.file).toBe(path.join(home, ".config", "opencode", "opencode.json"));
    expect(plan.before).toBe("");
    expect(existsSync(plan.file)).toBe(false); // the planner never writes
    expect(JSON.parse(plan.after)).toEqual({
      mcp: { servers: { opencadre: { type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_PLACEHOLDER" } } } },
    });
  });

  it("keeps every other key in the user's file, including other MCP servers", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    const before = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-4-5",
      theme: "tokyonight",
      mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" }, jira: { type: "remote", url: "https://jira.example.com/mcp", disabled: true } } },
    };
    writeFileSync(file, JSON.stringify(before, null, 2));

    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" });
    const after = JSON.parse(plan.after);
    expect(after.$schema).toBe(before.$schema);
    expect(after.model).toBe(before.model);
    expect(after.theme).toBe(before.theme);
    // The neighbours survive untouched...
    expect(after.mcp.servers.context7).toEqual(before.mcp.servers.context7);
    expect(after.mcp.servers.jira).toEqual(before.mcp.servers.jira);
    // ...and ours is added beside them.
    expect(after.mcp.servers.opencadre).toEqual({ type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_PLACEHOLDER" } });
    expect(Object.keys(after.mcp.servers)).toEqual(["context7", "jira", "opencadre"]);
  });

  it("replaces an existing opencadre entry instead of duplicating it", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    writeFileSync(file, JSON.stringify({
      mcp: { servers: { opencadre: { type: "remote", url: "https://old.example/mcp", headers: { Authorization: "Bearer agt_OLD" } } } },
    }));

    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_NEW" });
    const after = JSON.parse(plan.after);
    expect(Object.keys(after.mcp.servers)).toEqual(["opencadre"]);
    expect(after.mcp.servers.opencadre.url).toBe("https://hub.example/mcp");
    expect(after.mcp.servers.opencadre.headers.Authorization).toBe("Bearer agt_NEW");
    expect(plan.after).not.toContain("old.example");
  });

  it("refuses an opencode.jsonc file rather than destroy its comments", () => {
    const home = HOME_WITH_CONFIG();
    const jsoncFile = path.join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsoncFile, `{\n  // my comment\n  "model": "anthropic/claude-sonnet-4-5"\n}\n`);

    expect(() => planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" }))
      .toThrow(/opencode\.jsonc[\s\S]*comments/i);
    // The file is untouched.
    expect(readFileSync(jsoncFile, "utf8")).toContain("// my comment");
  });

  it("refuses an opencode.json that holds comments rather than silently drop them", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    writeFileSync(file, `{\n  // does not parse as JSON\n  "mcp": {}\n}\n`);

    expect(() => planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" }))
      .toThrow(/not valid JSON/i);
    expect(readFileSync(file, "utf8")).toContain("// does not parse as JSON");
  });

  it("prefers opencode.json when both spellings are present", () => {
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), "{}");
    writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), "{ /* commented */ }");
    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" });
    expect(plan.file).toBe(path.join(home, ".config", "opencode", "opencode.json"));
    expect(JSON.parse(plan.after).mcp.servers.opencadre.url).toBe("https://hub.example/mcp");
  });

  it("grows an mcp object that exists but has no servers key yet", () => {
    // A user (or an earlier OpenCadre version) can have `mcp` holding something else; the write must
    // add `servers` under it rather than replace `mcp` or throw.
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    writeFileSync(file, JSON.stringify({ mcp: { somethingElse: true }, model: "anthropic/claude-sonnet-4-5" }));

    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" });
    const after = JSON.parse(plan.after);
    expect(after.mcp.somethingElse).toBe(true);
    expect(after.model).toBe("anthropic/claude-sonnet-4-5");
    expect(after.mcp.servers.opencadre.url).toBe("https://hub.example/mcp");
  });
});

describe("opencode session-server install path (device connect)", () => {
  const PROXY = "/home/x/.opencadre/bin/opencadre-mcp.mjs";

  // The OpenCadre plugin (mail that wakes an idle chat, and clearance) is registered the documented way: an absolute
  // plugin folder under `plugins` (opencode.ai/v2/docs/build/plugins). Measured live 2026-09-23: registered like
  // this, it woke an idle OpenCode chat with a synthetic notice.
  it("registers the OpenCadre plugin folder under `plugins`, beside the user's own, and never twice", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    writeFileSync(file, JSON.stringify({ plugins: ["opencode-acme-plugin"] }));
    const plan = planOpencodeSessionServer({ home, proxyPath: PROXY });
    const pluginDir = path.join("/home/x/.opencadre/bin", "opencode-plugin");
    expect(JSON.parse(plan.after).plugins).toEqual(["opencode-acme-plugin", pluginDir]);
    // Reconnecting over the result adds nothing: the entry is recognised whatever its slashes or case.
    writeFileSync(file, JSON.stringify({ plugins: ["opencode-acme-plugin", pluginDir.replaceAll("\\", "/").toUpperCase()] }));
    expect(JSON.parse(planOpencodeSessionServer({ home, proxyPath: PROXY }).after).plugins).toHaveLength(2);
  });

  it("writes a type:local entry whose command is an ARRAY, not Claude Code's command+args", () => {
    const home = tempHome();
    const plan = planOpencodeSessionServer({ home, proxyPath: PROXY });
    expect(plan.file).toBe(path.join(home, ".config", "opencode", "opencode.json"));
    expect(plan.before).toBe("");
    expect(existsSync(plan.file)).toBe(false); // the planner never writes
    // The measured v2 shape: `command` is the whole argv as an array. `command: "node"` + `args: []`
    // is the Claude Code/Codex spelling and is not what this transport takes.
    expect(JSON.parse(plan.after).mcp.servers["opencadre-session"]).toEqual({
      type: "local",
      command: ["node", ...sessionServerArgs(PROXY, "opencode")],
      enabled: true,
    });
  });

  it("holds no credential - the proxy reads credentials.json itself", () => {
    const home = tempHome();
    const plan = planOpencodeSessionServer({ home, proxyPath: PROXY });
    expect(plan.after).not.toMatch(/Bearer|agt_|org_|dev_|ocd_|sk-/);
  });

  it("keeps other servers and the user's settings, and leaves a named-agent entry alone", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    // A named-agent remote entry (`opencadre`) and an unrelated server both predate this install.
    // A named agent wins at runtime, so connect must not remove or rewrite it here.
    const before = {
      model: "anthropic/claude-sonnet-4-5",
      mcp: { servers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" }, opencadre: { type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_NAMED" } } } },
    };
    writeFileSync(file, JSON.stringify(before, null, 2));

    const plan = planOpencodeSessionServer({ home, proxyPath: PROXY });
    const after = JSON.parse(plan.after);
    expect(after.model).toBe(before.model);
    expect(after.mcp.servers.context7).toEqual(before.mcp.servers.context7);
    expect(after.mcp.servers.opencadre).toEqual(before.mcp.servers.opencadre);
    expect(after.mcp.servers["opencadre-session"].type).toBe("local");
    expect(Object.keys(after.mcp.servers)).toEqual(["context7", "opencadre", "opencadre-session"]);
  });

  it("is idempotent: a second plan over the written file ends at the same bytes", () => {
    const home = HOME_WITH_CONFIG();
    const file = path.join(home, ".config", "opencode", "opencode.json");
    const first = planOpencodeSessionServer({ home, proxyPath: PROXY });
    writeFileSync(file, first.after);
    const second = planOpencodeSessionServer({ home, proxyPath: PROXY });
    expect(second.after).toBe(first.after);
  });

  it("refuses an opencode.jsonc file rather than destroy its comments, as the named-agent writer does", () => {
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), "{ // keep me\n}\n");
    expect(() => planOpencodeSessionServer({ home, proxyPath: PROXY })).toThrow(/jsonc/i);
  });

  // Measured 2026-09-23 on the fleet PC: OpenCode v2.0.10 had created ~/.config/opencode/opencode.jsonc holding plain
  // JSON (no comments) behind a byte-order mark, and connect refused it by NAME, so OpenCode could not be connected
  // there at all. Plain JSON in a .jsonc file loses nothing when rewritten, and it is the file OpenCode reads.
  it("writes into an opencode.jsonc that holds plain JSON (with a byte-order mark), keeping its settings", () => {
    const home = HOME_WITH_CONFIG();
    const jsonc = path.join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsonc, `﻿${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { x: { name: "X" } } }, null, 2)}\n`);
    const plan = planOpencodeSessionServer({ home, proxyPath: PROXY });
    expect(plan.file).toBe(jsonc);
    const after = JSON.parse(plan.after);
    expect(after.provider.x.name).toBe("X");
    expect(after.mcp.servers["opencadre-session"].type).toBe("local");
  });
});

describe("which opencode config file is written", () => {
  it("a comment-free opencode.jsonc is the target for the named-agent writer and the reader too", () => {
    const home = HOME_WITH_CONFIG();
    const jsonc = path.join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsonc, `{ "model": "anthropic/claude-sonnet-4-5" }\n`);
    expect(clientConfigFile(home, "opencode")).toBe(jsonc);
    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" });
    expect(plan.file).toBe(jsonc);
    expect(JSON.parse(plan.after).model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("a .jsonc with a trailing comma is not plain JSON, so it is still refused, untouched", () => {
    const home = HOME_WITH_CONFIG();
    const jsonc = path.join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsonc, `{ "model": "x", }\n`);
    expect(clientConfigFile(home, "opencode")).toBe(path.join(home, ".config", "opencode", "opencode.json"));
    expect(() => planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_PLACEHOLDER" })).toThrow(/jsonc/i);
    expect(readFileSync(jsonc, "utf8")).toBe(`{ "model": "x", }\n`);
  });
});

describe("opencode existing-entry reader", () => {
  it("finds an existing entry in a plain-JSON opencode.jsonc that starts with a byte-order mark", () => {
    // Reader parity with the writers (Codex-OpenCadre-8160 on 161495b): the writer targets this file, so the reader
    // must see what is already in it, or a connected OpenCode reads as unconfigured.
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), `﻿${JSON.stringify({
      mcp: { servers: { opencadre: { type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_BOM" } } } },
    })}`);
    expect(readExistingServer({ home, client: "opencode" })).toEqual({ found: true, table: "opencadre", url: "https://hub.example/mcp", key: "agt_BOM" });
  });

  it("finds the opencadre entry under mcp.servers", () => {
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      mcp: { servers: { opencadre: { type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_READ" } } } },
    }));
    // `table` names WHICH entry was found, and is part of the contract now: the reader recognises
    // both `opencadre` (named agent) and `opencadre-session` (the device path's keyless entry), so a
    // caller must be able to tell them apart rather than infer it from a missing key.
    expect(readExistingServer({ home, client: "opencode" })).toEqual({ found: true, table: "opencadre", url: "https://hub.example/mcp", key: "agt_READ" });
  });

  it("still finds an entry left in the flat mcp.<name> shape so a reconnect migrates it", () => {
    // The shape this writer used before the v2 measurement. v2.0.10 does not read it, so the tool is
    // not actually connected - but the reader must still see the entry, or a reconnect would report
    // "not connected" over a machine that has an OpenCadre config with a real key in it, and the
    // useful answer ("you are configured the old way, let me move you") is lost. The next write
    // migrates it; see the test below.
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      mcp: { opencadre: { type: "remote", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_STALE" } } },
    }));
    // `table: "opencadre"` is expected here too, added when main grew the SESSION_SERVER half. The
    // field is load-bearing display: `doctor.mjs` prints `[${server.table ?? "mcp_servers.opencadre"}]`
    // so a caller can tell a named-agent entry from a session one. This case predated that field and
    // used to expect a shape without it; the legacy entry is now folded into the same `servers` object
    // the nested case flows through, so both paths return ONE shape rather than two that must be kept
    // in step. Recorded rather than silently widened, because "the reader returns two shapes" was a
    // real property of the pre-merge code.
    expect(readExistingServer({ home, client: "opencode" })).toEqual({ found: true, table: "opencadre", url: "https://hub.example/mcp", key: "agt_STALE" });
  });

  it("moves a flat entry under mcp.servers on the next write", () => {
    // The migration the reader above deliberately allows: an entry the old writer left flat is found,
    // and the next plan rewrites it nested, where v2.0.10 actually reads it.
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      mcp: { opencadre: { type: "remote", url: "https://old.example/mcp", headers: { Authorization: "Bearer agt_STALE" } } },
    }));
    const plan = planClientConfig({ home, client: "opencode", hub: "https://hub.example", key: "agt_NEW" });
    const after = JSON.parse(plan.after);
    expect(after.mcp.servers.opencadre.url).toBe("https://hub.example/mcp");
    expect(after.mcp.opencadre).toBeUndefined();
    expect(plan.after).not.toContain("old.example");
  });

  it("reports not found when there is no opencadre entry", () => {
    const home = HOME_WITH_CONFIG();
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { servers: { other: { type: "remote", url: "https://other/mcp" } } } }));
    expect(readExistingServer({ home, client: "opencode" })).toEqual({ found: false });
  });
});
