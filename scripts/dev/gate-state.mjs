#!/usr/bin/env node
// How many tools actually pass the launch gate, and what is missing from each.
//
// The fleet spent a day producing thirty-six merged PRs while ZERO of twelve tools passed the gate,
// and nobody could see it, because the only place that number existed was a markdown table read by
// eye. Activity was instrumented; OUTPUT was not. This prints output.
//
//   node scripts/dev/gate-state.mjs                  # against the working tree, uncommitted edits INCLUDED
//   node scripts/dev/gate-state.mjs origin/main      # against a ref -- use this one for claims
//
// Exit 0 when at least one tool passes all six. Exit 1 when none does, so it can gate a claim.
//
// NAME A REF FOR ANY CLAIM. The working-tree form includes uncommitted edits, so a green from it
// says what the table would claim IF the edits landed -- never what main claims today.
//
// WHAT THIS MEASURES, stated plainly because the distinction is the whole point:
// it reads what the GATE TABLE CLAIMS. It does not re-run any capability. The table is the
// artifact the project treats as authoritative, and the definition of done says a cell moves only
// on a measurement recorded in that tool's HARNESS-<TOOL>.md -- so this reports the claim, and the
// verdict discipline is what keeps the claim honest. A tool reporting 6/6 here means "six cells
// assert it", never "I verified it just now". Do not quote this as evidence that a tool works.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const GATE = "docs/planning/LAUNCH-CLIENT-GATE.md";
const ref = process.argv[2] ?? null;
// PROVENANCE. The no-argument form reads the WORKING TREE, from disk, which is what the usage text
// above has always promised. It previously ran `git show HEAD:<gate>` and then printed the words
// "working tree" over HEAD's content -- so the output asserted a provenance it did not have. A lane
// hit it while splitting the app/IDE row: the edit was on disk, the tool reported the old table, and
// the tool briefly said a correct change had not worked. An instrument that mislabels WHERE it read
// is worse than one that cannot read at all, because its output still looks like evidence.
let text;
if (ref) {
  text = run("git", ["show", `${ref}:${GATE}`]);
} else {
  try {
    text = readFileSync(GATE, "utf8");
  } catch {
    console.error(`gate-state: cannot read ${GATE} from ${process.cwd()}.`);
    console.error("Run it from the repository root, or name a ref: gate-state.mjs origin/main");
    process.exit(1);
  }
}

// Rows are `| **Tool name** | cell | cell | ... |`. Only bolded first cells are tool rows; the
// capability table in section 1 uses numbered rows and is skipped by that same test.
const rows = text.split("\n").filter((l) => /^\|\s*\*\*/.test(l));
if (rows.length === 0) {
  console.error(`no tool rows found in ${source} — has the table shape changed?`);
  process.exit(2);
}

const CAPS = ["Connect", "Identity", "Mail", "Clearance", "Lapsed bill", "Verified"];
let complete = 0;
const lines = [];
// EVERY ROW SEEN MUST BE ACCOUNTED FOR. The first version of this file silently `continue`d past
// rows with fewer than six cells and printed "0 of 5" when the table held 8 tool rows -- a correct
// conclusion with a wrong denominator, and nothing on screen said three rows had been dropped.
// After #457 the Tier-2 tools are listed WITHOUT capability cells, so skipping them is right and
// hiding that they were skipped is not: a reader cannot tell a deliberate exclusion from a parser
// that quietly failed. Excluded rows are now named.
const excluded = [];

for (const row of rows) {
  // Split on pipes, drop the empty edges, and take the tool + the six capability cells. A row
  // carrying a trailing "gap to done" column is fine: we only read the first seven fields.
  const cells = row.split("|").slice(1, -1).map((c) => c.trim());
  const tool = cells[0].replace(/\*\*/g, "").trim();
  const caps = cells.slice(1, 7);
  if (caps.length < 6) { excluded.push({ tool, fields: cells.length }); continue; }

  // A cell counts as PASS only on the green tick. Amber, cross, empty and prose all count as NOT
  // passing -- deliberately, because "partial" is the state this project most often mistakes for
  // done, and an instrument that rounds amber up would launder exactly that error.
  const pass = caps.map((c) => c.includes("✅"));
  const n = pass.filter(Boolean).length;
  if (n === 6) complete++;
  const missing = CAPS.filter((_, i) => !pass[i]);
  lines.push({ tool, n, missing });
}

lines.sort((a, b) => b.n - a.n);
const width = Math.max(...lines.map((l) => l.tool.length));

console.log(`\nLAUNCH GATE  (${ref ?? "working tree"})  —  ${GATE}\n`);
for (const l of lines) {
  const bar = "█".repeat(l.n) + "░".repeat(6 - l.n);
  const tail = l.n === 6 ? "COMPLETE" : `missing: ${l.missing.join(", ")}`;
  console.log(`  ${l.tool.padEnd(width)}  ${bar}  ${l.n}/6   ${tail}`);
}

if (excluded.length) {
  console.log(`\n  not scored (no capability cells — listed in the table without a row of six):`);
  for (const e of excluded) console.log(`    ${e.tool}  (${e.fields} field${e.fields === 1 ? "" : "s"})`);
}

console.log(`\n  TOOLS COMPLETE: ${complete} of ${lines.length} scored` +
  (excluded.length ? `  (+${excluded.length} listed but not scored — see above)` : ""));
if (complete === 0) {
  console.log(`  No tool passes the gate. Merged PRs are not completions.`);
}
console.log("");
process.exit(complete > 0 ? 0 : 1);
