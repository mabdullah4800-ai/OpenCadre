import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { AgentNameError, checkAgentName, registerAgent } from "../src/service.js";
import { ProfileNameError } from "../src/agent-names.js";
import { nameSession } from "../src/devices.js";
import { approveConsent, createConsent } from "../src/oauth-authorize.js";
import { mcpResource } from "../src/oauth.js";
import { dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";
import { CORPUS_EXISTING, LOOKALIKE_CORPUS, type LookalikeCase } from "./fixtures/lookalike-corpus.js";

// ROBIN's 116-case lookalike corpus (tests/fixtures/lookalike-corpus.ts) through the ONE name validator, on each path
// that sets a name: checkAgentName (create, rename, seeds, member agents, connect codes), the consent page's typed name
// (approveConsent), and a profile's name (nameSession). Every case must also finish fast.

const PROFILE_SECTION = "6. Profile names (same pipeline) (7)";
const nameOf = (c: LookalikeCase) => String.fromCodePoint(...c.cps);
const agentCases = LOOKALIKE_CORPUS.filter((c) => c.section !== PROFILE_SECTION);
const profileCases = LOOKALIKE_CORPUS.filter((c) => c.section === PROFILE_SECTION);
const label = (c: LookalikeCase) => `${c.reason}${c.note ? ` (${c.note})` : ""}`;

/** A workspace holding the corpus's existing names, plus a case's own (a "reject iff X exists" case); reserved words
 * ("Operator", "admin") are minted as the hub mints them. */
function corpusWorkspace(plan?: string, extra: string[] = []): { orgId: string; personId: string } {
  const personId = person();
  const orgId = workspace(personId, plan ? { plan } : {});
  for (const name of [...CORPUS_EXISTING, ...extra]) registerAgent(orgId, name, { system: true });
  return { orgId, personId };
}

describe("lookalike corpus: checkAgentName (create, rename, seed and member paths)", () => {
  let orgId = "";
  beforeAll(() => {
    ({ orgId } = corpusWorkspace());
    checkAgentName(orgId, "Warm Up"); // the confusables table is decoded once, outside the timed cases
  });

  it.each(agentCases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const org = c.extraExisting ? corpusWorkspace(undefined, c.extraExisting).orgId : orgId;
    const started = performance.now();
    let outcome: "allow" | "reject" = "allow";
    try {
      checkAgentName(org, nameOf(c));
    } catch (err) {
      if (!(err instanceof AgentNameError)) throw err;
      outcome = "reject";
    }
    expect(outcome, label(c)).toBe(c.expect);
    expect(performance.now() - started, "fast").toBeLessThan(50);
  });

  it("X23 and X24, the decomposed and composed forms of one name, are duplicates of each other", () => {
    const { orgId: org } = corpusWorkspace();
    const [x23, x24] = ["X23", "X24"].map((id) => nameOf(LOOKALIKE_CORPUS.find((c) => c.id === id)!));
    registerAgent(org, x24);
    expect(() => checkAgentName(org, x23)).toThrow(AgentNameError);
  });
});

describe("lookalike corpus: the consent page's typed name (approveConsent)", () => {
  it.each(agentCases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { orgId, personId } = corpusWorkspace("internal", c.extraExisting);
    const consentId = createConsent({
      personId, clientId: dcrClient(), redirectUri: "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", state: "s",
    });
    const result = approveConsent({ consentId, personId, orgId, connectionName: nameOf(c) });
    if (!result.ok) expect(result.reason, label(c)).toBe("invalid_name");
    expect(result.ok ? "allow" : "reject", label(c)).toBe(c.expect);
  });
});

describe("lookalike corpus: profile names (nameSession)", () => {
  it.each(profileCases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { orgId } = corpusWorkspace();
    const session = registerAgent(orgId, "Pebble");
    db.prepare(`UPDATE agents SET kind = 'session' WHERE id = ?`).run(session.agentId);
    let outcome: "allow" | "reject" = "allow";
    try {
      nameSession(orgId, session.agentId, nameOf(c), { personId: "p", actor: { id: "a", name: "Owner" } });
    } catch (err) {
      if (!(err instanceof AgentNameError) && !(err instanceof ProfileNameError)) throw err;
      outcome = "reject";
    }
    expect(outcome, label(c)).toBe(c.expect);
  });
});
