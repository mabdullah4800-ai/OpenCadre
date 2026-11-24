import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { AgentNameError, checkAgentName, MAX_AGENT_NAME_CHARS, registerAgent } from "../src/service.js";
import { acceptInvite, createInvite, createWorkspace } from "../src/accounts.js";
import { buildSessionName, nameSession } from "../src/devices.js";
import { nameKeys, ProfileNameError } from "../src/agent-names.js";
import { person, workspace } from "./helpers/oauth-fixtures.js";

// Round 3, S3: a NEW agent name, on every creation path, can't pass for another agent's: no invisible or direction
// characters, no Latin mixed with Cyrillic or Greek, and no name that folds (NFKC, invisibles removed, lower-cased) to a
// name an agent here holds or held. Inputs are built from code points, so this file holds no invisible or lookalike
// character itself.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const SOFT_HYPHEN = cp(0xad);
const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const CYRILLIC_O = cp(0x41e);
const GREEK_O = cp(0x39f);
const FULLWIDTH_OPS = cp(0xff2f, 0xff50, 0xff53);
const CYRILLIC_WORD = cp(0x41e, 0x43f, 0x441); // a whole Cyrillic name, no Latin in it

const refusedWith = (fn: () => unknown, status: 400 | 409) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AgentNameError);
    expect((err as AgentNameError).status).toBe(status);
    return;
  }
  throw new Error("expected a refusal");
};

describe("checkAgentName and registerAgent refuse lookalike names (S3)", () => {
  it("an invisible or direction character is refused (400)", () => {
    const org = workspace(person());
    for (const name of [`Ops${SOFT_HYPHEN}`, `O${ZWJ}ps`, `${RLO}Ops`]) refusedWith(() => registerAgent(org, name), 400);
  });

  it("Latin mixed with Cyrillic or Greek is refused (400); one script alone is fine", () => {
    const org = workspace(person());
    refusedWith(() => registerAgent(org, `${CYRILLIC_O}ps`), 400);
    refusedWith(() => registerAgent(org, `${GREEK_O}ps`), 400);
    expect(registerAgent(org, "Ops").agentName).toBe("Ops");
    expect(registerAgent(org, CYRILLIC_WORD).agentName).toBe(CYRILLIC_WORD);
  });

  it("a name that folds to one an agent holds or held is taken (409), removed agents included", () => {
    const org = workspace(person());
    registerAgent(org, "Ops");
    refusedWith(() => registerAgent(org, FULLWIDTH_OPS), 409);
    const old = registerAgent(org, "Night Watch");
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(old.agentId);
    refusedWith(() => checkAgentName(org, "NIGHT WATCH"), 409);
  });

  it("an agent keeps its own name, and existing names are not re-judged", () => {
    const org = workspace(person());
    const self = registerAgent(org, "Relay");
    expect(checkAgentName(org, "relay", self.agentId)).toBe("relay");
    // A name stored before these rules (here, a mixed one written directly) stays readable and does not break others.
    db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run(`${CYRILLIC_O}ld`, self.agentId);
    expect(registerAgent(org, "Fresh").agentName).toBe("Fresh");
  });

  it("automatic session names still allocate", () => {
    const org = workspace(person());
    const name = buildSessionName(org);
    expect(checkAgentName(org, `${name} unused`)).toBe(`${name} unused`);
    expect(name.length).toBeGreaterThan(0);
  });

  it("a person whose display name has an emoji ZWJ sequence or mixed scripts still gets a workspace and a member agent", () => {
    for (const name of [`Ada ${cp(0x1f469)}${ZWJ}${cp(0x1f4bb)}`, `Ivan ${CYRILLIC_O}vanov`]) {
      const id = person();
      db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(name, id);
      const row = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Parameters<typeof createWorkspace>[0];
      const created = createWorkspace(row, `WS ${id.slice(-6)}`);
      const member = db.prepare(`SELECT a.name FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.org_id = ? AND m.person_id = ?`)
        .get(created.orgId, id) as { name: string };
      expect(member.name).not.toContain(ZWJ);
      expect(member.name.startsWith(name.slice(0, 3))).toBe(true);
    }
  });
});

describe("a member agent's name always fits, however long the display name is in UTF-16 (round 3 regression)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const personNamed = (name: string) => {
    const id = person();
    db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(name, id);
    return db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Parameters<typeof createWorkspace>[0];
  };
  const memberName = (orgId: string, personId: string) =>
    (db.prepare(`SELECT a.name FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.org_id = ? AND m.person_id = ?`)
      .get(orgId, personId) as { name: string }).name;
  const fits = (name: string) => {
    expect(name.length).toBeLessThanOrEqual(MAX_AGENT_NAME_CHARS);
    expect(name).not.toMatch(LONE_SURROGATE);
    expect(name.length).toBeGreaterThan(0);
  };

  it("sign-up with a display name of 60 emoji succeeds with the fallback name, and a second such member gets a suffix", () => {
    const emoji = cp(0x1f600).repeat(60);
    const first = personNamed(emoji);
    const { orgId } = createWorkspace(first, "Emoji WS");
    const one = memberName(orgId, first.id);
    fits(one);
    const second = personNamed(emoji);
    acceptInvite(createInvite(orgId, { id: "actor", name: "Owner" }, "admin", null).token, second);
    const two = memberName(orgId, second.id);
    fits(two);
    // No emoji in names (operator decision, 2026-10-31): a display name of emoji only leaves nothing, so the fallback is used.
    expect(one).toBe("Member");
    expect(two).toBe("Member (2)");
  });

  it("a display name that NFKC expands (U+FDFA, one character to eighteen) still joins", () => {
    const expanding = personNamed(cp(0xfdfa).repeat(10));
    const { orgId } = createWorkspace(expanding, "Expanding WS");
    fits(memberName(orgId, expanding.id));
  });
});

describe("UTS #39 skeletons, scripts, blanks and reserved names (round 4)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  // The reviewer's repro cases, each built from code points.
  const CYR_APPE = cp(0x430, 0x440, 0x440, 0x435); // Cyrillic a, er, er, ie
  const CYR_POP = cp(0x420, 0x43e, 0x440); // Cyrillic Er, o, er
  const GREEK_AXE = cp(0x391, 0x3a7, 0x395); // Greek Alpha, Chi, Epsilon
  const GREEK_CYR_KERT = cp(0x39a, 0x435, 0x440, 0x442); // Greek Kappa, then Cyrillic ie, er, te
  const ARMENIAN_O_PS = `${cp(0x555)}ps`;
  const CHEROKEE_U_PS = `${cp(0x13a4)}ps`;
  const TIFINAGH_YAR_PS = `${cp(0x2d54)}ps`;
  const DOTLESS_LINUX = `L${cp(0x131)}nux`;
  const DOTTED_LINUX = `L${cp(0x130)}NUX`;
  const STRASSE_SHARP = `Stra${cp(0xdf)}e`;
  const JAPANESE = cp(0x5c71, 0x7530, 0x305f, 0x308d, 0x3046); // Han, Han, Hiragana x3
  const JAPANESE_KATAKANA = cp(0x5c71, 0x7530, 0x30bf, 0x30ed, 0x30a6); // Han, Han, Katakana x3
  const KOREAN_WITH_HAN = cp(0x91d1, 0xbbfc, 0xc900); // Han, Hangul, Hangul
  const CYRILLIC_IVAN = cp(0x418, 0x432, 0x430, 0x43d);
  const HIRAGANA_HANGUL = cp(0x305f, 0xbbfc);

  it("a new name whose skeleton or fold equals a held name's is taken (409)", () => {
    for (const [held, lookalike] of [
      ["appe", CYR_APPE], ["Pop", CYR_POP], ["AXE", GREEK_AXE], ["Linux", DOTLESS_LINUX], ["Linux", DOTTED_LINUX],
      ["Strasse", STRASSE_SHARP], ["Ops", "0ps"], ["mila", "rnila"], ["llya", "lIya"],
    ]) {
      const org = workspace(person());
      registerAgent(org, held);
      refusedWith(() => registerAgent(org, lookalike), 409);
    }
  });

  it("a removed agent's name counts, and an agent keeps its own (a rename compares against the others only)", () => {
    const org = workspace(person());
    const gone = registerAgent(org, "Ops");
    db.prepare(`UPDATE agents SET removed_at = datetime('now') WHERE id = ?`).run(gone.agentId);
    refusedWith(() => registerAgent(org, "0ps"), 409);
    const self = registerAgent(org, "mila");
    expect(checkAgentName(org, "rnila", self.agentId)).toBe("rnila");
  });

  it("letters from more than one script are refused (400); CJK combinations and one script alone are fine", () => {
    const org = workspace(person());
    for (const mixed of [GREEK_CYR_KERT, ARMENIAN_O_PS, CHEROKEE_U_PS, TIFINAGH_YAR_PS, HIRAGANA_HANGUL]) refusedWith(() => registerAgent(org, mixed), 400);
    for (const fine of [JAPANESE, JAPANESE_KATAKANA, KOREAN_WITH_HAN, CYRILLIC_IVAN, "Cursor-b781", "Grok Bot 2", "Ops"]) {
      expect(registerAgent(org, fine).agentName).toBe(fine);
    }
  });

  it("a blank other than a space, any default-ignorable code point, and a leading combining mark are refused (400)", () => {
    const org = workspace(person());
    for (const bad of [
      `Atlas${cp(0x2800)}`, `At${cp(0xa0)}las`, `At${cp(0x3000)}las`, `At${cp(0x1680)}las`, `Atlas${cp(0xffa0)}`, `Atlas${cp(0x1d173)}`,
      `${cp(0x301)}Atlas`,
    ]) refusedWith(() => registerAgent(org, bad), 400);
    expect(registerAgent(org, "At las").agentName).toBe("At las");
  });

  it("reserved names, and their lookalikes, are refused (409) unless the hub mints the name itself", () => {
    const org = workspace(person());
    for (const reserved of ["Operator", "operator", "0perator", "OpenCadre", "Admin", "ADMIN", "System"]) refusedWith(() => registerAgent(org, reserved), 409);
    expect(registerAgent(org, "Operator", { role: "operator", system: true }).agentName).toBe("Operator");
  });

  it("a profile name gets the same checks: a fullwidth copy of an agent's name is taken", () => {
    const org = workspace(person());
    registerAgent(org, "Ops");
    const session = registerAgent(org, "Pebble");
    db.prepare(`UPDATE agents SET kind = 'session' WHERE id = ?`).run(session.agentId);
    const naming = { personId: "p", actor: { id: "a", name: "Owner" } };
    refusedWith(() => nameSession(org, session.agentId, cp(0xff2f, 0xff50, 0xff53), naming), 409);
    refusedWith(() => nameSession(org, session.agentId, "0ps", naming), 409);
    expect(() => nameSession(org, session.agentId, `Atlas${cp(0x2800)}`, naming)).toThrow(ProfileNameError);
    expect(nameSession(org, session.agentId, "Harbor", naming)?.profile.name).toBe("Harbor");
  });
});

describe("no emoji in names, on every path (operator decision, 2026-10-31)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  it("checkAgentName refuses an emoji (400) and allows plain digits, # and *", () => {
    const org = workspace(person());
    for (const name of [`Bot ${cp(0x1f680)}`, `Bot ${cp(0x1f1fa, 0x1f1f8)}`, `Bot ${cp(0x31, 0x20e3)}`, `Bot ${cp(0x1f3fb)}`]) refusedWith(() => registerAgent(org, name), 400);
    expect(registerAgent(org, "Agent #1").agentName).toBe("Agent #1");
    expect(registerAgent(org, "Agent *2").agentName).toBe("Agent *2");
  });

  it("a profile name with an emoji is refused (400)", () => {
    const org = workspace(person());
    const session = registerAgent(org, "Pebble");
    db.prepare(`UPDATE agents SET kind = 'session' WHERE id = ?`).run(session.agentId);
    expect(() => nameSession(org, session.agentId, `Harbor ${cp(0x1f680)}`, { personId: "p", actor: { id: "a", name: "Owner" } })).toThrow(ProfileNameError);
  });

  it("a member's display name loses its emoji, never failing sign-up", () => {
    const id = person();
    db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(`${cp(0x1f680)} Ada ${cp(0x1f469, 0x200d, 0x1f4bb)}`, id);
    const row = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Parameters<typeof createWorkspace>[0];
    const { orgId } = createWorkspace(row, "Emoji-free WS");
    const member = db.prepare(`SELECT a.name FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.org_id = ? AND m.person_id = ?`).get(orgId, id) as { name: string };
    expect(member.name).toBe("Ada");
  });
});

describe("ZWNJ only where a script needs it (proposed default)", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  it("a Persian word with a ZWNJ between its letters is allowed; a ZWNJ in a Latin name, or at an edge, is refused", () => {
    const org = workspace(person());
    const persian = cp(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645); // mi-khaham, "I want"
    expect(registerAgent(org, persian).agentName).toBe(persian);
    refusedWith(() => registerAgent(org, `Zed${cp(0x200c)}Bot`), 400);
    refusedWith(() => registerAgent(org, `${cp(0x645, 0x6cc, 0x200c)}`), 400);
  });
});

describe("the fold key and the as-given check, pinned on their own", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  it("the fold key folds sharp s, long s, the dotted capital I and the dotless i", () => {
    expect(nameKeys(`Stra${cp(0xdf)}e`).fold).toBe(nameKeys("Strasse").fold);
    expect(nameKeys(`${cp(0x17f)}ystem`).fold).toBe(nameKeys("system").fold);
    expect(nameKeys(`L${cp(0x130)}NUX`).fold).toBe(nameKeys("linux").fold);
    expect(nameKeys(`L${cp(0x131)}nux`).fold).toBe(nameKeys("linux").fold);
  });

  it("a leading U+FEFF on a fresh name is refused (400), not trimmed away", () => {
    const org = workspace(person());
    refusedWith(() => registerAgent(org, `${cp(0xfeff)}Zed`), 400);
  });
});
