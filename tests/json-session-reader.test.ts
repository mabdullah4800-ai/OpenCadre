// The JSON clients' reader must find the SESSION entry, not only the named-agent one.
//
// THE DEFECT, board task 2b60c623, found while measuring Claude Code for its harness doc:
//
//   $ claude mcp list
//   opencadre-session: node …\opencadre-mcp.mjs --client claude-code - ✔ Connected
//   $ node cli/bin/opencadre.mjs doctor --client claude-code
//   [red] ~/.claude.json has no [mcp_servers.opencadre]     verdict=not_connected   exit=1
//
// The entry was present under a DIFFERENT KEY. The device path writes `opencadre-session`
// (cli/lib/device.mjs planSessionServer, keyed on SESSION_SERVER); the reader looked only for
// `opencadre`.
//
// WHY THIS IS A REGRESSION RATHER THAN A NEW BUG. The identical defect was found and fixed for
// CODEX on 2026-09-18 — cli/lib/clients.mjs's readCodexServer carries the comment recording it —
// and the fix was never carried across to readExistingServer, which every JSON client uses. So the
// bug was fixed on one sibling and left on the others, and the one it was left on is Claude Code,
// which #457 makes launch-critical.
//
// THE SWEEP IS THE POINT. A test that only covered claude-code would have passed while cursor,
// antigravity, gemini and opencode kept the defect — so these cases iterate every client the JSON
// reader serves, and assert their own premise (that the list is non-empty) so the sweep cannot
// silently empty out.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clientConfigFile, readExistingServer, SESSION_SERVER } from "../cli/lib/clients.mjs";
import { planCodexSessionServer, planSessionServer } from "../cli/lib/device.mjs";

const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-session-reader-"));

/** Every client `readExistingServer` serves in its JSON branch (codex goes through readCodexServer). */
const JSON_CLIENTS = ["claude-code", "cursor", "antigravity", "gemini", "opencode"];

/** Write `body` as this client's config file, creating the directories it needs. */
function writeConfig(home: string, client: string, body: unknown) {
  const file = clientConfigFile(home, client);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

/** The config body wrapping `entry` in the container THIS CLIENT's reader looks in.
 *
 * IT USED TO RETURN A BARE `"mcp"` KEY for OpenCode, and that went stale the moment #460 changed the
 * registry's container for it from `"mcp"` to `["mcp", "servers"]`. The flat shape is the pre-v2 one
 * that `opencode mcp list` reports as "No MCP servers configured"; the reader correctly stops finding
 * it, so this helper was writing a config the code under test is right to miss — a red that describes
 * the FIXTURE, not the reader.
 *
 * WHY THE DEPTH IS NOT DERIVED FROM THE REGISTRY HERE, which would be better if it were available:
 * `clients.mjs` does not export its `JSON_CLIENTS` table (only `hasConfigWriter` reads it), and this
 * file's own `JSON_CLIENTS` is a LIST OF NAMES, not that table — reading `.container` off it would be
 * undefined for every client and silently yield `mcpServers` for all of them, including OpenCode. So
 * the two-segment case is named explicitly, and the failure mode if the registry changes again is a
 * red in the assertion below rather than a fixture that quietly writes the wrong shape. */
function containerFor(client: string, entry: unknown): unknown {
  return client === "opencode" ? { mcp: { servers: entry } } : { mcpServers: entry };
}

describe("the writers actually run, so a broken binding cannot hide", () => {
  // WHY THIS EXISTS, and it is a defect this file's own tests could not catch.
  //
  // #465 moved SESSION_SERVER into clients.mjs and made device.mjs RE-EXPORT it:
  //     export { SESSION_SERVER } from "./clients.mjs";
  // A pure re-export makes the name visible to IMPORTERS but does NOT bind it in device.mjs's own
  // scope — and two functions in that file USE it (`[SESSION_SERVER]:` in planSessionServer and
  // `mcp_servers.${SESSION_SERVER}` in planCodexSessionServer). Both were therefore left referencing
  // an undefined identifier, and the file threw on use: "SESSION_SERVER is not defined".
  //
  // The reader tests below did not catch it because they CONSTRUCT the entry shape by hand rather
  // than calling the writer — they described what device.mjs writes without ever running it. The
  // failure surfaced only when a merge brought in a test that drives the real device path.
  //
  // So these call the WRITERS. A module that merely imports is not evidence; the use sites have to run.
  it("runs every device writer that uses the SESSION_SERVER constant", () => {
    const home = tempHome();
    const claude = planSessionServer({ home, proxyPath: "/proxy.mjs", client: "claude-code" });
    expect(claude.after).toContain(SESSION_SERVER);
    // The OTHER use site, via a template literal — both must be exercised, not just the first.
    const codex = planCodexSessionServer({ home, proxyPath: "/proxy.mjs" });
    expect(codex.after).toContain(SESSION_SERVER);
  });

  it("still exposes the constant to importers, from both homes that did before", async () => {
    // The re-export half of the contract: device.mjs is where every existing importer reads it, and
    // clients.mjs is where it now lives. Both must resolve, or a consumer breaks one direction while
    // the other still works — which is exactly how this defect got in.
    const device = await import("../cli/lib/device.mjs");
    const clients = await import("../cli/lib/clients.mjs");
    expect(device.SESSION_SERVER).toBe("opencadre-session");
    expect(clients.SESSION_SERVER).toBe("opencadre-session");
    expect(device.SESSION_SERVER).toBe(clients.SESSION_SERVER);
  });
});

describe("the JSON reader finds the SESSION entry the device path writes", () => {
  it("finds opencadre-session for EVERY JSON client, and does not call it missing", () => {
    const seen: string[] = [];
    for (const client of JSON_CLIENTS) {
      const home = tempHome();
      // Exactly what device.mjs's planSessionServer writes: keyless, stdio, no url, no Authorization.
      writeConfig(home, client, containerFor(client, { [SESSION_SERVER]: { type: "stdio", command: "node", args: ["/proxy.mjs", "--client", client] } }));

      const r = readExistingServer({ home, client });
      expect({ client, found: r.found }).toEqual({ client, found: true });
      // Named so a caller can say "session server, credential in credentials.json" rather than
      // reporting a missing key as though something were wrong.
      expect({ client, table: r.table }).toEqual({ client, table: SESSION_SERVER });
      expect({ client, sessionServer: r.sessionServer }).toEqual({ client, sessionServer: true });
      seen.push(client);
    }
    // The sweep's own premise: it iterated the full set, so an empty or truncated list fails loudly
    // instead of passing vacuously.
    expect(seen).toEqual(JSON_CLIENTS);
  });

  it("still finds the NAMED-AGENT entry, and reports its key", () => {
    // The half that already worked must keep working: a session fix that broke the named-agent read
    // would be a worse defect than the one being repaired.
    const home = tempHome();
    writeConfig(home, "claude-code", { mcpServers: { opencadre: { type: "http", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_EXAMPLE" } } } });
    expect(readExistingServer({ home, client: "claude-code" })).toEqual({ found: true, table: "opencadre", url: "https://hub.example/mcp", key: "agt_EXAMPLE" });
  });

  it("prefers the SESSION entry when BOTH are present, as the codex reader does", () => {
    // Same rationale readCodexServer gives: the session entry is what the device path writes and
    // what chats actually use, so a machine carrying both is mid-migration.
    const home = tempHome();
    writeConfig(home, "claude-code", {
      mcpServers: {
        [SESSION_SERVER]: { type: "stdio", command: "node", args: ["/proxy.mjs"] },
        opencadre: { type: "http", url: "https://hub.example/mcp", headers: { Authorization: "Bearer agt_EXAMPLE" } },
      },
    });
    const r = readExistingServer({ home, client: "claude-code" });
    expect({ table: r.table, sessionServer: r.sessionServer }).toEqual({ table: SESSION_SERVER, sessionServer: true });
  });

  it("reports not found when NEITHER key is present", () => {
    // The negative case, so the tests above are not passing because the reader returns found for
    // everything.
    const home = tempHome();
    writeConfig(home, "claude-code", { mcpServers: { somethingElse: { type: "http", url: "https://other/mcp" } } });
    expect(readExistingServer({ home, client: "claude-code" })).toEqual({ found: false });
  });

  it("keys the session entry on the SAME constant the device path writes it with", () => {
    // The two halves cannot spell the entry differently — which is exactly how the JSON clients came
    // to miss it. This asserts the shared constant rather than a repeated literal.
    expect(SESSION_SERVER).toBe("opencadre-session");
  });
});
