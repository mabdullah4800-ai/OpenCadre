import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { AgentNameError, checkAgentName, registerAgent } from "../src/service.js";
import { nameSession } from "../src/devices.js";
import { nameKeyStats, nameProblem, RESERVED_NAMES, safeNameBase, skeleton } from "../src/agent-names.js";
import { confusablePrototypes } from "../src/confusables.js";
import { approveConsent, createConsent } from "../src/oauth-authorize.js";
import { mcpResource } from "../src/oauth.js";
import { dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// The Grok team's re-review of a3ca7c61 (N1-N6). Inputs are built from code points where they hold anything but plain
// ASCII, so this file holds no lookalike or invisible character itself.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const TM = cp(0x2122);
const REG = cp(0xae);
const COPY = cp(0xa9);

function refused(org: string, name: string): number {
  try {
    checkAgentName(org, name);
  } catch (err) {
    if (err instanceof AgentNameError) return err.status;
    throw err;
  }
  return 0;
}
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "(accepted)";
}
const holding = (...held: string[]) => {
  const org = workspace(person());
  for (const name of held) registerAgent(org, name, { system: true });
  return org;
};
const sessionIn = (org: string) => {
  const session = registerAgent(org, `Pebble ${Math.random().toString(36).slice(2, 6)}`);
  db.prepare(`UPDATE agents SET kind = 'session' WHERE id = ?`).run(session.agentId);
  return session.agentId;
};
const NAMING = { personId: "p", actor: { id: "a", name: "Owner" } };

describe("N1: reserved words glued to another word", () => {
  it.each([
    "AdminTeam", "TeamAdmin", "ADMINTEAM", "SysAdmin", "HubAdmin", "OperatorBot", "SystemBot", "OpenCadreBot", "MyOpenCadre",
    "Admins",
    // pins: a reserved word split across two words, run together; and inside a run of capitals
    "Ad Minteam", "Sys Admin", "OPERATORTEAM", "MYOPENCADREBOT", "MyAdminTeam", "TheOperatorDesk",
  ])("%s is refused as reserved (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });

  it.each([
    "Systems Lab", "Administer", "Operators Guild", "Administration", "Ecosystem", "Admiral", "Hubert", "Supporter",
    "Support Team", "HubSupport", "Root Cause", "Security Team", "Badminton", "Cooperator",
    // found by the dictionary check (the 30,000 most common English Wikipedia words)
    "Administrative", "Administratively", "Administered", "Administrated", "Systematic", "Systematics", "Systemic",
    "Subsystems", "Microsystems", "Filesystem", "Ecosystems",
  ])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});

describe("N2: decoration never makes a name different", () => {
  it.each([
    ["Atlas", `Atlas${COPY}`], ["Atlas", `Atlas${TM}`], ["ROBIN", `ROBIN${REG}`], ["Grok Bot", `Grok Bot${TM}`],
    ["Grok Bot", "Grok:Bot"], ["Grok Bot", "Grok/Bot"], ["Grok Bot", "Grok+Bot"], ["Grok Bot", "Grok~Bot"], ["Grok Bot", "Grok,Bot"],
  ])("with %s held, %s is refused (409)", (held, name) => {
    expect(refused(holding(held), name)).toBe(409);
  });

  it.each([`Root${TM}`, `Hub${REG}`, `Security${TM}`, `Support${COPY}`, "Support!", `Admin${cp(0x2bc)}s`, `Admin${cp(0x2bb)}s`])(
    "%s counts as the reserved word (409)",
    (name) => {
      expect(refused(holding(), name)).toBe(409);
    },
  );

  it("the signs stay allowed for display when nothing like the name is held", () => {
    const org = holding();
    expect(registerAgent(org, `Atlas${TM}`).agentName).toBe(`Atlas${TM}`);
    expect(refused(org, "Atlas")).toBe(409);
  });
});

describe("N3: marks keep distinct Indic and kana names distinct", () => {
  const KARAN = cp(0x915, 0x930, 0x923);
  const KIRAN = cp(0x915, 0x93f, 0x930, 0x923);
  const GAKU = cp(0x304c, 0x304f);
  const KAKU = cp(0x304b, 0x304f);
  it.each([[KARAN, KIRAN], [KIRAN, KARAN], [GAKU, KAKU], [KAKU, GAKU]])("with %s held, %s is allowed", (held, name) => {
    expect(refused(holding(held), name)).toBe(0);
  });

  it("a decomposed copy of a held kana name is still the same name", () => {
    expect(refused(holding(GAKU), cp(0x304b, 0x3099, 0x304f))).toBe(409);
  });

  it("an accent on a Latin, Greek or Cyrillic letter still compares as its letter", () => {
    expect(refused(holding("Jose"), `Jos${cp(0xe9)}`)).toBe(409);
    expect(refused(holding(cp(0x3b1, 0x3bb, 0x3c6, 0x3b1)), cp(0x3ac, 0x3bb, 0x3c6, 0x3b1))).toBe(409);
    expect(refused(holding(cp(0x415, 0x436)), cp(0x401, 0x436))).toBe(409);
  });
});

describe("N4: a 409 names the clash", () => {
  it("checkAgentName (create, rename, connect codes) says which agent, profile or reserved word it looks like", () => {
    const org = holding("Jose", "Muller");
    expect(messageOf(() => checkAgentName(org, `Jos${cp(0xe9)}`))).toBe(`Jos${cp(0xe9)} looks like Jose, an agent in this workspace; choose another name`);
    expect(messageOf(() => checkAgentName(org, `M${cp(0xfc)}ller`))).toBe(`M${cp(0xfc)}ller looks like Muller, an agent in this workspace; choose another name`);
    expect(messageOf(() => checkAgentName(org, "AdminTeam"))).toBe("AdminTeam looks like Admin, a reserved name; choose another name");
    expect(messageOf(() => checkAgentName(org, `Root${TM}`))).toBe(`Root${TM} looks like Root, a reserved name; choose another name`);
    expect(messageOf(() => checkAgentName(org, "operator"))).toBe("operator is a reserved name; choose another name");
  });

  it("a profile's name and a name an agent had are named too", () => {
    const org = holding("Gate");
    nameSession(org, sessionIn(org), "Harbor", NAMING);
    expect(messageOf(() => checkAgentName(org, "Harb0r"))).toBe("Harb0r looks like Harbor, a profile in this workspace; choose another name");
    const gate = db.prepare(`SELECT id FROM agents WHERE org_id = ? AND name = 'Gate'`).pluck().get(org) as string;
    db.prepare(`UPDATE agents SET name = 'Gate Two' WHERE id = ?`).run(gate);
    expect(messageOf(() => checkAgentName(org, "Ga-te"))).toBe("Ga-te looks like Gate, a name an agent in this workspace had; choose another name");
  });

  it("naming a session (the profile path) says it too", () => {
    const org = holding("Jose");
    expect(messageOf(() => nameSession(org, sessionIn(org), `Jos${cp(0xe9)}`, NAMING))).toBe(`Jos${cp(0xe9)} looks like Jose, an agent in this workspace; choose another name`);
    expect(messageOf(() => nameSession(org, sessionIn(org), "SysAdmin", NAMING))).toBe("SysAdmin looks like Admin, a reserved name; choose another name");
  });

  it("the consent page says it, with a free name filled in", () => {
    const p = person();
    const org = workspace(p);
    registerAgent(org, "Jose");
    const typed = (name: string) => approveConsent({
      consentId: createConsent({
        personId: p, clientId: dcrClient(), redirectUri: "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", state: "s",
      }),
      personId: p, orgId: org, connectionName: name,
    });
    expect(typed(`Jos${cp(0xe9)}`)).toMatchObject({ ok: false, message: `Jos${cp(0xe9)} looks like Jose, an agent in this workspace. We filled in Jos${cp(0xe9)} 2.` });
    expect(typed("OperatorBot")).toMatchObject({ ok: false, message: "OperatorBot looks like Operator, a reserved name. We filled in Connection." });
  });
});

describe("N5: a legacy chillu (virama, then ZWJ, at the end of a word)", () => {
  const AVAN = cp(0xd05, 0xd35, 0xd28, 0xd4d, 0x200d); // Malayalam, its last letter a chillu written the old way
  it("is allowed at the end of the name and before a space", () => {
    expect(nameProblem(AVAN)).toBeNull();
    expect(nameProblem(`${AVAN} ${cp(0xd30, 0xd3e, 0xd1c, 0xd4d)}`)).toBeNull();
    expect(refused(holding(), AVAN)).toBe(0);
  });

  it("a ZWJ at the end of a word after anything but a virama is still refused", () => {
    expect(nameProblem(cp(0xd05, 0xd35, 0xd28, 0x200d))).toBe("invisible");
    expect(nameProblem(`Zed${cp(0x200d)}`)).toBe("invisible");
    expect(nameProblem(`${cp(0xd05, 0xd35, 0xd28, 0xd4d, 0x200d, 0x200d)}`)).toBe("invisible");
  });
});

describe("N6: a derived name keeps the vertical presentation forms readable", () => {
  it("U+FE31 becomes its prototype l, and U+FE32 is dropped, never a dash", () => {
    expect(safeNameBase(`Ad${cp(0xfe31)}er`)).toBe("Adler");
    expect(safeNameBase(`Ad${cp(0xfe32)}er`)).toBe("Ader");
  });
});

// The independent Claude re-review of a3ca7c61 (P1-P3).
describe("P1: real names stay apart, as UTS #39 keeps them", () => {
  it.each([
    ["Clay", "Day"], ["Clark", "Dark"], ["Cliff", "Diff"], ["Anna", "Arna"], ["Hanna", "Harna"],
  ])("%s and %s are two names, in either order", (a, b) => {
    expect(refused(holding(a), b)).toBe(0);
    expect(refused(holding(b), a)).toBe(0);
  });

  // Eli and Ell, Bill and Bili, Will and Wiil were two names here; the Grok re-review of 5190cd4c (S2, the operator's
  // "no lookalike residuals") makes i and l one letter in every key, so they are one name now (tests S2 below).
  it.each([["Tom", "Torn"], ["Sam", "Sarn"], ["Kim", "Kirn"], ["ALI", "ALl"]])("%s and %s stay one name (UTS #39 maps m to rn, capital I to l)", (a, b) => {
    expect(refused(holding(a), b)).toBe(409);
    expect(refused(holding(b), a)).toBe(409);
  });

  it.each([["Alex", "Al Ex"], ["Mary Ann", "Maryann"], ["Jo-Ann", "Joann"], ["Sea", "Sea."]])("%s and %s are one name: the second reads as the first", (a, b) => {
    expect(refused(holding(a), b)).toBe(409);
  });
});

describe("P2: a reserved word spelled out in single letters", () => {
  it.each(["A d m i n Bot", "O p e r a t o r Team", "Team S y s t e m", "A.d.m.i.n Desk"])("%s is refused (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });
  it.each(["A B C Team", "J R R Tolkien Fans", "T E A M Bot"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});

describe("P3: a held name's keys are worked out once", () => {
  it("with 30,000 held names, a second check works out keys for the new candidate only", () => {
    const org = holding();
    const agent = db.prepare(`SELECT id FROM agents WHERE org_id = ? LIMIT 1`).pluck().get(org) as string | undefined;
    const owner = agent ?? registerAgent(org, "Keeper").agentId;
    const insert = db.prepare(`INSERT INTO agent_addresses (org_id, name_key, name, agent_id) VALUES (?, ?, ?, ?)`);
    db.transaction(() => {
      for (let n = 0; n < 30_000; n++) insert.run(org, `held name ${n}`, `Held Name ${n}`, owner);
    })();
    checkAgentName(org, "Fresh Candidate One");
    const before = nameKeyStats.computed;
    checkAgentName(org, "Fresh Candidate Two");
    const worked = nameKeyStats.computed - before;
    // The candidate, and the words and runs of words the reserved-word check reads it in; never the held names again.
    expect(worked).toBeGreaterThan(0);
    expect(worked).toBeLessThan(20);
  });
});

// The Grok team's re-review of 1459a120 (R1-R5).
describe("R1: a whole-script lookalike in mixed case is refused", () => {
  it.each([
    ["Cyrillic ATIas", cp(0x410, 0x422, 0x406, 0x430, 0x455), ["Atlas"]],
    ["Cyrillic OperaTor", cp(0x41e, 0x440, 0x435, 0x433, 0x430, 0x422, 0x43e, 0x433), []],
    ["Lisu ATIAS", cp(0xa4ee, 0xa4d4, 0xa4f2, 0xa4ee, 0xa4e2), ["Atlas"]],
    ["Cyrillic rooT", cp(0x433, 0x43e, 0x43e, 0x422), []],
    ["Coptic rooT", cp(0x2c85, 0x2c9f, 0x2c9f, 0x2ca6), []],
    ["Canadian syllabics HUb", cp(0x157c, 0x144c, 0x1472), []],
    ["HU, tone six", `HU${cp(0x184)}`, []],
    ["Greek AdMiN", cp(0x391, 0x1018b, 0x39c, 0x3b9, 0x39d), []],
    ["Cyrillic GroK BoT", `${cp(0x50c, 0x433, 0x43e, 0x41a)} ${cp(0x412, 0x43e, 0x422)}`, ["Grok Bot"]],
    ["Grok, tone six, ot", `Grok ${cp(0x184)}ot`, ["Grok Bot"]],
  ])("%s is refused", (_label, name, held) => {
    expect(refused(holding(...held), name)).not.toBe(0);
  });

  // Lisu, Coptic and Canadian syllabics letters that UTS #39 reads as a Latin letter. A copy is built two ways:
  //  - from the name as written, each letter replaced by a lookalike of it in either case (the mixed-case whole-script
  //    copy R1 is about: a Cyrillic "ATlas" for Atlas);
  //  - from the name in capitals, each letter replaced by a lookalike of exactly that capital (Lisu has only capitals).
  // Since S2, i and l are one letter, so a lookalike of either stands for either ("OIIVE" in Lisu for Olive).
  const BLOCKS: Array<[string, number, number]> = [["Lisu", 0xa4d0, 0xa4ff], ["Coptic", 0x2c80, 0x2cff], ["Canadian syllabics", 0x1400, 0x167f]];
  const lookalikesIn = (lo: number, hi: number) => {
    const exact = new Map<string, string[]>();
    for (let c = lo; c <= hi; c++) {
      const proto = confusablePrototypes().get(c);
      if (proto && /^[A-Za-z]$/.test(proto)) exact.set(proto, [...(exact.get(proto) ?? []), cp(c)]);
    }
    const fold = (s: string) => skeleton(s).toLowerCase().replace(/i/g, "l");
    const all = [...exact.values()].flat();
    return {
      asWritten: (ch: string) => all.filter((c) => fold(c) === fold(ch)),
      capital: (ch: string) => exact.get(skeleton(ch.toUpperCase())) ?? [],
    };
  };
  const copies = (target: string, pick: (ch: string) => string[], rand: (n: number) => number, n: number) => {
    const letters = [...target].filter((ch) => ch !== " ");
    if (!letters.every((ch) => pick(ch).length)) return [];
    return Array.from({ length: n }, () => [...target].map((ch) => (ch === " " ? " " : pick(ch)[rand(pick(ch).length)])).join(""));
  };
  const HELD = ["Atlas", "Grok Bot", "Codex", "ClaudeCode", "apple", "paypal", "Olive", "Linux", "Basil"];
  it.each(BLOCKS)("%s copies of the held and reserved names are refused (fuzz)", (_block, lo, hi) => {
    const org = holding(...HELD);
    const map = lookalikesIn(lo, hi);
    let seed = 1459;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const accepted: string[] = [];
    let tried = 0;
    for (const target of [...HELD, ...RESERVED_NAMES]) {
      for (const copy of [...copies(target, map.asWritten, rand, 40), ...copies(target.toUpperCase(), map.capital, rand, 40)]) {
        tried++;
        if (refused(org, copy) === 0) accepted.push(`${target}: ${[...copy].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`);
      }
    }
    expect(tried).toBeGreaterThan(0);
    expect([...new Set(accepted)]).toEqual([]);
  });

  it("the Lisu copies of OpenCadre, Codex, ClaudeCode, apple and paypal are refused", () => {
    const org = holding("Codex", "ClaudeCode", "apple", "paypal");
    const map = lookalikesIn(0xa4d0, 0xa4ff);
    for (const target of ["OpenCadre", "Codex", "ClaudeCode", "apple", "paypal"]) {
      const copy = [...target.toUpperCase()].map((ch) => map.capital(ch)[0]).join("");
      expect(refused(org, copy), target).not.toBe(0);
    }
  });

  it("a capital I is an l: ELI and Ell are one name (and, since S2, Eli and Ell too)", () => {
    expect(refused(holding("Ell"), "ELI")).toBe(409);
    expect(refused(holding("Ell"), "Eli")).toBe(409);
  });
});

describe("R2: an l for an i in a reserved word", () => {
  it.each(["Admln", "admln", "Adrnln", "Systern Admln", "Adminlstrator", "AdmlnTeam"])("%s is refused (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });
  it("held names too, since S2: Eli and Ell, Mila and Mlla are one name", () => {
    expect(refused(holding("Eli"), "Ell")).toBe(409);
    expect(refused(holding("Mila"), "Mlla")).toBe(409);
  });
});

describe("R4: Operators, alone or with one generic word", () => {
  it.each(["Operators", "OPERATORS", "0perators", "Operators Team", "Operators Bot", "Operators Desk", "Operators Staff", "Operators Group", "Operators Crew", "Operators Admin", "Systems", "Systems Team"])(
    "%s is refused (409)",
    (name) => {
      expect(refused(holding(), name)).toBe(409);
    },
  );
  it.each(["Operators Guild", "Operators Guild Team", "Systems Lab", "Night Operators Club"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});

describe("R5: ordinary words written in camelCase or with a hyphen", () => {
  it.each(["EcoSystem", "FileSystem", "SubSystem", "CoOperator", "Co-operator", "Co-Operators Guild", "Systemically", "File-System"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
  it.each(["Sysadmin", "SysAdmin", "Adminstration", "EcoSystem Admin", "Sys-Admin"])("%s is refused (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });
});

// The Claude re-review of 1459a120 (its residuals, folded in with R1-R5).
describe("C1: cl for d and nn for m, against the reserved words only", () => {
  it.each(["Aclmin", "ACLMIN", "Aclministrator", "Adnnin", "Systenn", "Aclmin Bot"])("%s is refused (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });
  it.each([["Clay", "Day"], ["Anna", "Arna"]])("held names keep them apart: %s and %s are two names", (a, b) => {
    expect(refused(holding(a), b)).toBe(0);
    expect(refused(holding(b), a)).toBe(0);
  });
  it.each(["Clara", "Annie", "Clay", "Anna", "Clint Dunn"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});

describe("C2: a name of punctuation or symbols only", () => {
  it.each(["+++", "***", "!!", "- . -"])("%s is refused (400): it needs a letter or digit", (name) => {
    expect(refused(holding(), name)).toBe(400);
    expect(messageOf(() => checkAgentName(holding(), name))).toBe("name must contain a letter or digit");
  });
  it.each(["7", "#1", "Agent *2"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});

describe("C3: tool names, and plurals of role words", () => {
  it.each(["systemd", "systemctl", "adminer", "Systemd Watcher"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
  it.each(["admins", "Admins", "sysadmins", "SysAdmins", "sysadmin", "operators", "Biosystem", "Kadmin"])("%s is refused (409)", (name) => {
    expect(refused(holding(), name)).toBe(409);
  });
});

// The Grok team's re-review of 5190cd4c (S1, S2, S4).
describe("S1: lookalikes whose skeleton holds a small i", () => {
  it.each([
    ["outlined R, 0, outlined B, inverted !, script N", "ROBIN", cp(0x1cce7, 0x30, 0x1ccd7, 0xa1, 0x1d4a9)],
    ["math R, o, Beta, inverted !, script N", "ROBIN", cp(0x1d4e1, 0x1d52c, 0x1d757, 0xa1, 0x1d4a9)],
    ["math R, 0, outlined B, APL iota, script n", "ROBIN", cp(0x1d64d, 0x1d7d8, 0x1ccd7, 0x2373, 0x1d4c3)],
    ["Cherokee small v, L Y A", "Ilya", cp(0xab75, 0x13de, 0x13a9, 0x13aa)],
  ])("%s is refused with %s held", (_label, held, name) => {
    expect(refused(holding(held), name)).not.toBe(0);
  });
});

describe("S2: i and l are one letter in held names too", () => {
  it.each([
    ["Mila", "Mlla"], ["Basil", "BASll"], ["Linux", "LlnuX"], ["Olive", cp(0xa4f3, 0xa4f2, 0xa4f2, 0xa4e6, 0xa4f0)],
    ["Eli", "Ell"], ["Ali", "All"], ["Bill", "Bili"], ["Will", "Wiil"], ["Neil", "Nell"], ["Lia", "Ila"], ["Celia", "Cella"],
  ])("with %s held, %s is refused (409); and the other way round", (a, b) => {
    expect(refused(holding(a), b)).toBe(409);
    expect(refused(holding(b), a)).toBe(409);
  });
  it("the message names the other agent, so the refusal is never a dead end", () => {
    expect(messageOf(() => checkAgentName(holding("Eli"), "Ell"))).toBe("Ell looks like Eli, an agent in this workspace; choose another name");
  });
  it.each([["Clay", "Day"], ["Anna", "Arna"]])("cl and nn stay reserved-only: %s and %s are two names", (a, b) => {
    expect(refused(holding(a), b)).toBe(0);
  });
});

describe("S4: Operators or Systems with a reserved word", () => {
  it.each(["Operators Hub", "Systems Support", "Operators Security", "Systems Owner", "Operators Root", "Systems Operator", "Hub Operators"])(
    "%s is refused (409)",
    (name) => {
      expect(refused(holding(), name)).toBe(409);
    },
  );
  it.each(["Operators Guild", "Systems Lab"])("%s is allowed", (name) => {
    expect(refused(holding(), name)).toBe(0);
  });
});
