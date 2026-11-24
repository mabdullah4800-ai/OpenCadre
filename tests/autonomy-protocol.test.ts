import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Agents kept stopping to wait for a human after every message. Every client gets the same autonomy
// rules at session start (Claude Code / Codex CLI hook, Antigravity hook, Codex desktop skill), so a
// fleet keeps working unless a step truly needs a person.
const AUTONOMY = [
  "- Act on mail and tasks the moment they arrive; never wait for a human to say continue.",
  "- Decide yourself (record_decision if non-obvious). Missing info? Ask another agent and keep working.",
  "- Involve a human only for credentials, payments, spending, publishing, approving a risky clearance, changing another agent's access (keys, roles, kill switch), or a decision the operator reserved: request_approval, then do other work.",
  "- Code: branch, PR, review by another agent matching the change's risk, merge after approval, confirm the hash, add a regression test."
];

const CLIENT_INSTRUCTIONS = {
  "Claude Code / Codex CLI hook": "examples/hooks/opencadre-awareness.mjs",
  "Antigravity hook": "examples/hooks/opencadre-antigravity.mjs",
  "Codex desktop skill": "cli/templates/codex-inbox-skill.md",
  "Antigravity rules file": ".agent/rules/opencadre-inbox.md",
};

describe("autonomy protocol", () => {
  for (const [client, file] of Object.entries(CLIENT_INSTRUCTIONS)) {
    it(`${client} carries every autonomy rule verbatim`, () => {
      const text = readFileSync(file, "utf8");
      for (const line of AUTONOMY) expect(text).toContain(line.replace(/^- /, ""));
    });

    it(`${client} names no specific fleet agent (it ships to every customer)`, () => {
      expect(readFileSync(file, "utf8")).not.toMatch(/ClaudeCode-Session|ClaudeCode-PC-Beta|Codex-Session|Antigravity-Session/);
    });
  }
});
