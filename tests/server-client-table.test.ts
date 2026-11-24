import { describe, expect, it } from "vitest";
import { CONNECT_CLIENTS } from "../src/connect.js";
import { TOOLS } from "../src/devices.js";
import { CLIENT_NAMES, COMPUTER_TOOLS } from "../scripts/opencadre-clients.mjs";

/**
 * The server's client list is a SECOND copy of the canonical table, and nothing pinned it.
 *
 * scripts/opencadre-clients.mjs exists so the client lists cannot drift: it was written after three
 * hand-maintained lists in two files did drift. But src/ never imports it. src/connect.ts spells its
 * own CONNECT_CLIENTS literally, src/rest.ts and src/devices.ts validate against that copy, and
 * src/devices.ts derives TOOLS from it. So the "one table" is one table for the CLI and a copy for
 * the hub.
 *
 * The drift that resulted, measured against a running server rather than read off the source:
 *   POST /v1/connect-codes {client:"dsh"} -> 400 "client must be one of auto, claude-code, ..."
 *   POST /v1/connect-codes {client:"claude-code"} -> 201
 * and the CLI accepts dsh today (DEVICE_CLIENTS = ["claude-code","codex","dsh"]). So
 * `opencadre connect --client dsh` passes the CLI's own check and the server then refuses the code.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS CONTAINMENT AND NOT EQUALITY. The two lists are not the same kind
 * of thing. The server's copy is a list of clients it will accept a connect code for; the canonical
 * table also carries clients that are still being measured (cursor, gemini are device:false). Exact
 * set equality happens to hold today and would break the moment a measuring client is wired up, at
 * which point a "fix" to satisfy the equality would be wrong. The invariant that is actually true is
 * that every client a computer credential SERVES must be one the server knows:
 *
 *     COMPUTER_TOOLS  ⊆  CONNECT_CLIENTS \ { "auto" }
 *
 * Do not tighten this to an equality assertion without deciding what the server's list means.
 */
describe("the server's client list agrees with the canonical table", () => {
  // "auto" is connect-time shorthand meaning "detect the client", not a client. The canonical table
  // has no such row, so it is stripped before comparing rather than added as a fake entry.
  const serverClients = (CONNECT_CLIENTS as readonly string[]).filter((c) => c !== "auto");

  it("accepts every client a computer credential serves", () => {
    const unreachable = COMPUTER_TOOLS.filter((client: string) => !serverClients.includes(client));
    // Named in the message on purpose: this failing should say WHICH client is unreachable, because
    // the symptom in production is a 400 naming a list, with nothing pointing at the missing row.
    expect(
      unreachable,
      `the hub refuses connect codes for these served clients: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  it("derives the server's TOOLS from that same list, so the gap is not patched in one place only", () => {
    // src/devices.ts:274 computes TOOLS = CONNECT_CLIENTS.filter(c => c !== "auto"). This asserts the
    // derivation still holds, so a future edit cannot add a client to TOOLS without the server
    // accepting it, or vice versa.
    expect(TOOLS as readonly string[]).toEqual(serverClients);
  });

  it("names an unknown client the same way in both lists' vocabulary", () => {
    // The canonical table is the source of truth for what a client is called. Every name the server
    // accepts should be a name the table knows, so a typo'd row cannot be served under one spelling
    // and refused under another.
    const unknown = serverClients.filter((client: string) => !CLIENT_NAMES.includes(client));
    expect(unknown, `the server accepts clients the canonical table does not define: ${unknown.join(", ")}`).toEqual([]);
  });
});
