// PR-E1, addendum §2.4: no dated-removal promise in shipped code or in the changelog.
//
// "That older signature is dropped after 2026-10-31" (CHANGELOG) and "Remove `sig` ... in the first release after
// 2026-10-31: by then every machine has run `connect --upgrade`" (a source comment, removed by #688) are the same
// unfounded calendar assumption: a date is not evidence that customers upgraded (docs/design/CONNECTOR-COMPATIBILITY.md).
// A removal needs a recorded compatibility decision with customer notice.
//
// TWO HALVES, because a ban alone is satisfied by deleting the answer: the dated phrases must be ABSENT, and the
// replacement wording must be PRESENT. And the scanner is run against the old text (BASE's CHANGELOG, and the last
// commit with the source comment), which it must flag, so a scanner that matches nothing cannot pass.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** origin/main when PR-E1 was cut: its CHANGELOG still carried the dated promise. */
const BASE = "3e5c23df6d7bde06168da883e9847885523e00b2";
/** The parent of #688 (25b6250b): the last commit with the dated source comment in scripts/opencadre-config.mjs. */
const COMMENT_ERA = "eef8aa3f86107e893e108017239db08b70280512";

const DATE = String.raw`20\d\d-\d\d-\d\d`;
const DATED_REMOVAL = [
  // "dropped after 2026-10-31", "removed by 2027-01-01", "retired on ..."
  new RegExp(String.raw`\b(?:dropped|removed|deleted|retired|disabled|turned off|switched off|stops? working)\s+(?:after|on|by|from)\s+${DATE}`, "i"),
  // "remove ... in the first release after 2026-10-31"
  new RegExp(String.raw`\b(?:remove|drop|delete|retire)\b[^.]{0,120}?\b(?:after|on|by)\s+${DATE}`, "i"),
  // "after 2026-10-31: by then every machine has ..."; "by 2026-10-31 every machine ..."
  new RegExp(String.raw`\b(?:by|after)\s+${DATE}\s*[:,]?\s*(?:by then\s+)?every\s+(?:machine|computer|customer|install)`, "i"),
];

/** Line breaks and comment leaders collapsed, so a phrase wrapped across comment lines still reads as one sentence. */
const flatten = (text: string) => text.replace(/\r?\n[ \t]*(?:\/\/+|\*+(?!\/)|#+)?[ \t]*/g, " ");
const datedRemovals = (text: string) => {
  const flat = flatten(text);
  return DATED_REMOVAL.flatMap((re) => {
    const m = flat.match(re);
    return m ? [m[0]] : [];
  });
};

const TEXT = /\.(?:mjs|cjs|js|ts|md|json|toml|sh|ps1|txt)$/;
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}
const show = (rev: string, file: string) => execFileSync("git", ["show", `${rev}:${file}`], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

describe("no dated removal in scripts/, examples/, cli/ or CHANGELOG.md", () => {
    // PUBLIC-SNAPSHOT SKIP: depends on the private pre-release git history or on internal docs that are not in this repository. See CONTRIBUTING.md, "Skipped tests".
  it.skip("the scanner flags the old wording (known positives: BASE's CHANGELOG, and the source comment's last commit)", () => {
    expect(datedRemovals(show(BASE, "CHANGELOG.md"))).toEqual(["dropped after 2026-10-31"]);
    expect(datedRemovals(show(COMMENT_ERA, "scripts/opencadre-config.mjs")).length).toBeGreaterThan(0);
    expect(datedRemovals(show(COMMENT_ERA, "scripts/opencadre-config.mjs")).join(" ")).toMatch(/after 2026-10-31/);
  });
  it("no file carries a dated removal phrase now", () => {
    const root = process.cwd();
    const hits = [...["scripts", "examples", "cli"].flatMap((d) => files(path.join(root, d))), path.join(root, "CHANGELOG.md")]
      .flatMap((file) => datedRemovals(readFileSync(file, "utf8")).map((m) => `${path.relative(root, file)}: ${m}`));
    expect(hits).toEqual([]);
  });
  it("the replacement wording is present where the dated promise was (the config comment)", () => {
    const config = flatten(readFileSync(path.join(process.cwd(), "scripts", "opencadre-config.mjs"), "utf8"));
    expect(config).toContain("Keep the dual field until an evidence-backed compatibility decision documents affected cohorts, a security rationale and customer recovery notices. A calendar date is not evidence that customers upgraded.");
  });
});
