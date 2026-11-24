import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { AgentNameError, checkAgentName, registerAgent, resolveAgent } from "../src/service.js";
import { createWorkspace } from "../src/accounts.js";
import { approveConsent, createConsent, freeConnectionName } from "../src/oauth-authorize.js";
import { mcpResource } from "../src/oauth.js";
import { dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// The Grok team's bypass hunt on fab693c1 (F1-F6): every accepted lookalike, as a failing case first. Inputs are built
// from code points, so this file holds no lookalike or invisible character itself.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const BS = String.fromCharCode(92);

/** A workspace holding `held` (reserved words minted as the hub mints them). */
function holding(...held: string[]): string {
  const org = workspace(person());
  for (const name of held) registerAgent(org, name, { system: true });
  return org;
}
function refused(org: string, name: string): number {
  try {
    checkAgentName(org, name);
  } catch (err) {
    if (err instanceof AgentNameError) return err.status;
    throw err;
  }
  return 0;
}

// [id, bypass, held names it imitates (none: a reserved word)]
const BYPASSES: Array<[string, string, string[]]> = [
  // F1: case ordering lost I/l.
  ["F1 ADMlN", "ADMlN", []],
  ["F1 ADMlNlSTRATOR", "ADMlNlSTRATOR", []],
  ["F1 SECURlTY", "SECURlTY", []],
  ["F1 OLlVE", "OLlVE", ["Olive"]],
  ["F1 LlNUX", "LlNUX", ["Linux"]],
  ["F1 BASlL", "BASlL", ["Basil"]],
  ["F1 ADM script-l N", `ADM${cp(0x2113)}N`, []],
  ["F1 ADM fullwidth-l N", `ADM${cp(0xff4c)}N`, []],
  ["F1 Cyrillic birch", cp(0x42c, 0x456, 0x433, 0x441, 0x4bb), ["BIRCH"]],
  ["F1 APL-alpha mber", `${cp(0x237a)}mber`, ["AMBER"]],
  ["F1 Ernrna", "Ernrna", ["EMMA"]],
  ["F1 rnila", "rnila", ["Mila"]],
  // F2: NFKC ran before the skeleton.
  ["F2 At vertical-line as", `At${cp(0xfe31)}as`, ["Atlas"]],
  ["F2 ROB vertical-line N", `ROB${cp(0xfe31)}N`, ["ROBIN"]],
  ["F2 Ad vertical-line er", `Ad${cp(0xfe31)}er`, ["Adler"]],
  ["F2 long-s ox", `${cp(0x17f)}ox`, ["Fox"]],
  ["F2 lunate capital sigma", cp(0x3f9, 0x391, 0x3a1, 0x395), ["CAPE"]],
  ["F2 lunate small sigma", cp(0x3f2, 0x3bf, 0x3c1), ["Cop"]],
  // F3: script-specific marks survived.
  ["F3 Atlas + Thai mark", `Atlas${cp(0xe31)}`, ["Atlas"]],
  ["F3 Atlas + Hebrew accent", `Atlas${cp(0x591)}`, ["Atlas"]],
  ["F3 Atlas + Tibetan vowel", `Atlas${cp(0xf7a)}`, ["Atlas"]],
  ["F3 Atlas + Cyrillic millions", `Atlas${cp(0x489)}`, ["Atlas"]],
  // F4: reserved words inside a name.
  ["F4 Operator 2", "Operator 2", []],
  ["F4 OpenCadre (2)", "OpenCadre (2)", []],
  ["F4 OpenCadre Support", "OpenCadre Support", []],
  // F5: a name equal to another agent's url key, or one separator away.
  ["F5 grok-bot", "grok-bot", ["Grok Bot"]],
  ["F5 GrokBot", "GrokBot", ["Grok Bot"]],
  ["F5 Grok_Bot", "Grok_Bot", ["Grok Bot"]],
  // F6: letter groups. ("Coclex" for Codex is no longer refused: the cl-for-d fold made Clay and Day one name, and
  // UTS #39 has no such fold; tests/name-rereview.test.ts P1.)
  ["F6 slashes olf", `${BS}/${BS}/olf`, ["Wolf"]],
];

describe("the F1-F6 bypasses of fab693c1 are refused", () => {
  it.each(BYPASSES)("%s", (_id, bypass, held) => {
    const org = holding(...held);
    expect(refused(org, bypass)).not.toBe(0);
  });

  it("the Thai, Hebrew, Tibetan and Cyrillic marks on a Latin letter are refused even with nothing held (400)", () => {
    const org = holding();
    for (const mark of [0xe31, 0x591, 0xf7a, 0x489]) expect(refused(org, `Zed${cp(mark)}`)).toBe(400);
  });

  it("a stored name carrying a script mark (set before these rules) still holds its letters: Atlas is taken", () => {
    const org = holding();
    const legacy = registerAgent(org, "Legacy Holder");
    db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run(`Atlas${cp(0xe31)}`, legacy.agentId);
    expect(refused(org, "Atlas")).toBe(409);
  });

  it("the other order: Grok Bot after grok-bot, GrokBot or Grok_Bot is refused", () => {
    for (const first of ["grok-bot", "GrokBot", "Grok_Bot"]) expect(refused(holding(first), "Grok Bot"), first).toBe(409);
  });

  it("a name equal to a live agent's url key or id is refused", () => {
    const org = holding();
    const a = registerAgent(org, "Pathfinder");
    db.prepare(`UPDATE agents SET url_key = 'special-key' WHERE id = ?`).run(a.agentId);
    expect(refused(org, "special-key")).toBe(409);
    expect(refused(org, a.agentId)).toBe(409);
  });
});

describe("routing resolves by exact name first, then url key, then id", () => {
  // Legacy rows can still clash (names set before these rules); resolveAgent must not pick between them by chance.
  for (const swap of [false, true]) {
    it(swap ? "created in the other order" : "created in one order", () => {
      const org = holding();
      const [first, second] = [registerAgent(org, "Alpha One"), registerAgent(org, "Beta Two")];
      const [a, b] = swap ? [second, first] : [first, second];
      db.prepare(`UPDATE agents SET name = 'clash-x' WHERE id = ?`).run(a.agentId);
      db.prepare(`UPDATE agents SET url_key = 'clash-x' WHERE id = ?`).run(b.agentId);
      expect(resolveAgent(org, "clash-x")?.id, "an exact name beats a url key").toBe(a.agentId);
      db.prepare(`UPDATE agents SET url_key = ? WHERE id = ?`).run(b.agentId, a.agentId);
      expect(resolveAgent(org, b.agentId)?.id, "a url key beats an id").toBe(a.agentId);
    });
  }
});

describe("reserved words: suggestions and derived names never land on one", () => {
  it("a member named after a reserved word gets the fallback, not a numbered reserved name", () => {
    for (const name of ["Operator", "OpenCadre", "Admin"]) {
      const id = person();
      db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(name, id);
      const row = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Parameters<typeof createWorkspace>[0];
      const { orgId } = createWorkspace(row, `WS ${name}`);
      const member = db.prepare(`SELECT a.name FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.org_id = ? AND m.person_id = ?`)
        .get(orgId, id) as { name: string };
      expect(member.name, name).toBe("Member");
    }
  });

  it("an app named after a reserved word gets the Connection default; a typed 0perator gets a suggestion that is itself free", () => {
    const org = holding();
    expect(freeConnectionName(org, "OpenCadre")).toBe("Connection");
    expect(freeConnectionName(org, "Operator")).toBe("Connection");
    const p = person();
    const ws = workspace(p);
    const consentId = createConsent({
      personId: p, clientId: dcrClient(), redirectUri: "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", state: "s",
    });
    const result = approveConsent({ consentId, personId: p, orgId: ws, connectionName: "0perator" });
    expect(result.ok).toBe(false);
    const suggested = !result.ok && result.reason === "invalid_name" ? result.suggestedName : undefined;
    expect(suggested).toBeDefined();
    expect(suggested!.startsWith("0perator")).toBe(false);
    expect(refused(ws, suggested!)).toBe(0);
  });
});

describe("legitimate names still pass", () => {
  it.each(["Cursor-b781", "Grok Bot 2", "Agent #1", "Support Team", "Security Scanner", "Hub Watcher", "Mo Anderson", "Ada Lovelace"])("%s", (name) => {
    expect(refused(holding("Grok Bot"), name)).toBe(0);
  });

  it("Coclex with Codex held is allowed: UTS #39 has no cl-for-d fold, and one would make Clay and Day one name", () => {
    expect(refused(holding("Codex"), "Coclex")).toBe(0);
  });
});
