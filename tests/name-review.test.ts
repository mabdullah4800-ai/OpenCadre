import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { AgentNameError, checkAgentName, registerAgent } from "../src/service.js";
import { memberAgentName } from "../src/accounts.js";
import { approveConsent, createConsent, freeConnectionName } from "../src/oauth-authorize.js";
import { createConnectCode, redeemConnectCode } from "../src/connect.js";
import { mcpResource } from "../src/oauth.js";
import { dcrClient, person, workspace } from "./helpers/oauth-fixtures.js";

// The independent review of fab693c1 (A-H), beyond the Grok team's F1-F6 (tests/name-bypass.test.ts). Inputs are built
// from code points, so this file holds no lookalike or invisible character itself.
const cp = (...points: number[]) => String.fromCodePoint(...points);

function refused(org: string, name: string): number {
  try {
    checkAgentName(org, name);
  } catch (err) {
    if (err instanceof AgentNameError) return err.status;
    throw err;
  }
  return 0;
}
const holding = (...held: string[]) => {
  const org = workspace(person());
  for (const name of held) registerAgent(org, name, { system: true });
  return org;
};

describe("A: combining marks", () => {
  it("every combining mark, appended to or inside the reserved Operator, is refused", () => {
    const org = holding();
    const marks: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (/^\p{M}$/u.test(String.fromCodePoint(c))) marks.push(c);
    }
    expect(marks.length).toBeGreaterThan(2000);
    const accepted = marks.flatMap((m) => [`Operator${cp(m)}`, `Oper${cp(m)}ator`].filter((name) => refused(org, name) === 0).map(() => m.toString(16)));
    expect(accepted, "marks accepted").toEqual([]);
  });

  it("the Tifinagh joiner U+2D7F and the Khitan filler U+16FE4 are invisible (400)", () => {
    const org = holding();
    expect(refused(org, `Zed${cp(0x2d7f)}Bot`)).toBe(400);
    expect(refused(org, `Zed${cp(0x16fe4)}Bot`)).toBe(400);
  });
});

describe("B and C: capital M, lone lookalikes and small capitals", () => {
  const SC = (...points: number[]) => cp(...points);
  it.each([
    ["S, small-cap Y, STEM", `S${SC(0x28f)}STEM`],
    ["S, small-cap Y, steM", `S${SC(0x28f)}steM`],
    ["SYSTE, small-cap M", `SYSTE${SC(0x1d0d)}`],
    ["Latin alpha, dMin", `${SC(0x251)}dMin`],
    ["OPERATOR in small capitals", SC(0x1d0f, 0x1d18, 0x1d07, 0x280, 0x1d00, 0x1d1b, 0x1d0f, 0x280)],
    ["OP, small-cap E, RATOR", `OP${SC(0x1d07)}RATOR`],
    ["ROO, small-cap T", `ROO${SC(0x1d1b)}`],
    ["ROOT in small capitals", SC(0x280, 0x1d0f, 0x1d0f, 0x1d1b)],
    ["small-cap H, UB", `${SC(0x29c)}UB`],
    ["SUPPOR, small-cap T", `SUPPOR${SC(0x1d1b)}`],
    ["OWN, small-cap E, R", `OWN${SC(0x1d07)}R`],
    ["S, small-cap E, CURITY", `S${SC(0x1d07)}CURITY`],
    ["OPENCADR, small-cap E", `OPENCADR${SC(0x1d07)}`],
  ])("%s is refused", (_label, name) => {
    expect(refused(holding(), name)).not.toBe(0);
  });
});

describe("D: reserved words as tokens", () => {
  it.each(["Operator2", "Operator-", "The Operator", "Operator (2)", "0perator Bot", "Admin_Bot"])("%s is refused", (name) => {
    expect(refused(holding(), name)).not.toBe(0);
  });
});

describe("E: derived names never fail", () => {
  it("an orphaned mark left by a dropped letter is dropped too", () => {
    const org = holding();
    const raw = `O${cp(0x5bb)}${cp(0x427, 0x423)}`; // a Latin O, a Hebrew point, then Cyrillic letters
    const member = memberAgentName(org, raw);
    expect(refused(org, member)).toBe(0);
    const app = freeConnectionName(org, raw);
    expect(refused(org, app)).toBe(0);
  });

  it("2,000 random mixed-script display names and app names all give a valid name, never a throw", () => {
    const org = holding("Grok Bot", "Operator", "Admin");
    const pool = [
      [0x41, 0x5a], [0x61, 0x7a], [0x30, 0x39], [0x20, 0x20], [0x2d, 0x2e], [0x410, 0x44f], [0x391, 0x3c9], [0x531, 0x586],
      [0x5d0, 0x5ea], [0x5b0, 0x5bd], [0x627, 0x64a], [0x64b, 0x652], [0x905, 0x939], [0x93e, 0x94d], [0xe01, 0xe2e],
      [0xe31, 0xe3a], [0x4e00, 0x4e20], [0x3041, 0x3096], [0x30a1, 0x30fa], [0xac00, 0xac40], [0x300, 0x36f],
      [0x1d00, 0x1d2b], [0xff21, 0xff3a], [0x1f600, 0x1f64f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2800, 0x2800],
      [0xfe00, 0xfe0f], [0x13a0, 0x13f4], [0x2d30, 0x2d7f], [0xa9, 0xae], [0x2122, 0x2122], [0xd800, 0xd800],
    ];
    let seed = 20261031;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 2000; i++) {
      let s = "";
      for (let n = 1 + rand(24); n > 0; n--) {
        const [lo, hi] = pool[rand(pool.length)];
        s += String.fromCodePoint(lo + rand(hi - lo + 1));
      }
      const label = JSON.stringify([...s].map((c) => c.codePointAt(0)!.toString(16)));
      const member = memberAgentName(org, s);
      expect(refused(org, member), `member from ${label}: ${member}`).toBe(0);
      const app = freeConnectionName(org, s);
      expect(refused(org, app), `app from ${label}: ${app}`).toBe(0);
    }
    // A correctness sweep, not a timing check: about 8,000 full name checks (3.4 s alone here), past the 5 s default when
    // the whole suite loads the machine.
  }, 30_000);
});

describe("F: I, i and l are one letter", () => {
  // P1 kept Eli and Ell apart; the Grok re-review of 5190cd4c (S2, the operator's "no lookalike residuals") folds i and
  // l in every key, an accepted over-refusal: the 409 names the other agent, so it is never a dead end.
  it("ALI, ALl and ALL are one name, and so are Eli and Ell (S2)", () => {
    expect(refused(holding("ALI"), "ALl")).toBe(409);
    expect(refused(holding("ALI"), "ALL")).toBe(409);
    expect(refused(holding("Eli"), "Ell")).toBe(409);
  });
});

describe("G: small regressions", () => {
  it("a connect code minted with a name that is no longer valid answers its 400, not a 500", () => {
    const org = workspace(person(), { plan: "internal" });
    const operator = registerAgent(org, "Code Minter", { role: "operator" });
    const minted = createConnectCode(org, { id: operator.agentId }, "Fresh Agent", "claude-code");
    db.prepare(`UPDATE connect_codes SET agent_name = ? WHERE agent_name = 'Fresh Agent'`).run(`Fresh${cp(0x200b)}Agent`);
    const redeemed = redeemConnectCode(minted.code);
    expect(redeemed).toMatchObject({ ok: false, status: 400 });
  });

  it("the copyright, registered and trade mark signs are allowed; with VS16 they are refused", () => {
    const org = holding();
    for (const name of [`Acme${cp(0x2122)} Bot`, `Widget${cp(0xae)}`, `${cp(0xa9)} Studio`]) expect(refused(org, name), name).toBe(0);
    expect(refused(org, `${cp(0xa9, 0xfe0f)} Studio`)).toBe(400);
  });

  it("a ZWJ between letters of an Indic script or Sinhala is allowed; elsewhere it is refused", () => {
    const org = holding();
    const malayalam = cp(0xd15, 0xd3e, 0xd30, 0xd4d, 0x200d, 0xd24, 0xd4d, 0xd24, 0xd3f, 0xd15, 0xd4d); // Karthik
    const sinhala = cp(0xdc1, 0xdca, 0x200d, 0xdbb, 0xdd3); // Sri
    expect(refused(org, malayalam)).toBe(0);
    expect(refused(org, sinhala)).toBe(0);
    expect(refused(org, `Zed${cp(0x200d)}Bot`)).toBe(400);
    expect(refused(org, cp(0x1f468, 0x200d, 0x1f4bb))).toBe(400);
  });

  it("every path stores NFC: the consent page's typed name keeps its fullwidth letters, a decomposed accent is composed", () => {
    const p = person();
    const org = workspace(p);
    const typed = (name: string) => {
      const consentId = createConsent({
        personId: p, clientId: dcrClient(), redirectUri: "https://claude.ai/api/mcp/auth_callback", resource: mcpResource(),
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", state: "s",
      });
      const result = approveConsent({ consentId, personId: p, orgId: org, connectionName: name });
      if (!result.ok) throw new Error(result.message);
      return (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(result.agentId) as { name: string }).name;
    };
    expect(typed(`Ope${cp(0x301)}ra`)).toBe(`Op${cp(0xe9)}ra`);
    const fullwidth = cp(0xff27, 0xff52, 0xff4f, 0xff4b);
    expect(typed(`${fullwidth} Desk`)).toBe(`${fullwidth} Desk`);
  });
});

describe("H: one scan of the held names per call", () => {
  it("a default among 60 held numbered names is found quickly", () => {
    const org = holding();
    registerAgent(org, "Relay");
    for (let n = 2; n <= 60; n++) registerAgent(org, `Relay ${n}`);
    const started = performance.now();
    expect(freeConnectionName(org, "Relay")).toBe("Relay 61");
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("pins: rules no other rule covers", () => {
  it("the Tifinagh joiner and the Khitan filler are refused between letters of their own script", () => {
    const org = holding();
    expect(refused(org, cp(0x2d5c, 0x2d7f, 0x2d5c))).toBe(400);
    expect(refused(org, cp(0x18b00, 0x16fe4, 0x18b01))).toBe(400);
  });

  it.each(["2Operator", "Operator2Bot"])("a reserved word with digits stuck to it, %s, is refused", (name) => {
    expect(refused(holding(), name)).not.toBe(0);
  });

  it("a mark whose letter was dropped mid-name goes with it, so the name is kept rather than replaced by the fallback", () => {
    const org = holding();
    const raw = cp(0x427, 0x423, 0x427, 0x5d0, 0x5b8, 0x427, 0x423); // Cyrillic, a Hebrew alef with its own vowel point, Cyrillic
    expect(memberAgentName(org, raw)).toBe(cp(0x427, 0x423, 0x427, 0x427, 0x423));
  });
});
