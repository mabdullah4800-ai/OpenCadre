// §9 item 8 — the agent's key must not be exported into Codex's shell environment.
//
// THE DEFECT. `connect` wrote the agent key under `[shell_environment_policy.set]` so hooks and wake
// scripts would find the hub. Everything under that table is forwarded to every command Codex runs,
// so the key was readable by any `env` the model executed — HARNESS-CODEX.md §9 item 8, ranked by
// that doc as a credential exposure rather than by its item number.
//
// THE VENDOR'S NAME FILTER IS OPT-IN, NOT A GUARD WE DEFEATED — MEASURED, and it corrects this file's
// own first draft. The claim was: `ignore_default_excludes` defaults true and filters names containing
// KEY/SECRET/TOKEN (DOCS, fetched 2026-09-20; the page has since 308-redirected to
// learn.chatgpt.com/docs/config-file/config-basic), so Codex's own guard would have excluded this key
// and our `set` entry overrode it. The DOC quote is accurate. **The inference from it was not.**
//
// Driven against the real `codex` binary on this box (`codex sandbox -c … cmd /c set`, 2026-09-20,
// codex-cli 0.155.1), with OPENCADRE_KEY in the parent environment:
//
//   | policy                                            | OPENCADRE_KEY reaches the command? |
//   |---------------------------------------------------|------------------------------------|
//   | default (nothing set)                             | **YES — not filtered**             |
//   | ignore_default_excludes = false                    | NO — filtered                      |
//   | filters = { OPENCADRE_KEY = "exclude" }            | NO — filtered                      |
//
// **So the name alone was never protected.** With the default policy the key passed through even
// without any `set` entry, which means the old write did not "defeat a guard" — it added a second
// copy of a value that was already reaching every command. The exposure is exactly as serious; the
// MECHANISM is different, and the mechanism decides what the honest remedy is: there is no vendor
// protection to restore, so the fix is to stop writing the copy and to stop relying on the env at all.
//
// This correction is recorded rather than silently applied because the wrong version was plausible
// and quotable — a real doc sentence, correctly cited, with an inference stacked on top that no one
// had driven. Both readers of the earlier draft accepted it.
//
// THE FIX IS SAFE, AND THE SAFETY IS THE THING MOST WORTH TESTING. Every consumer resolves through
// `resolveNamedAgent` (scripts/opencadre-config.mjs), whose order is: the env pair, ELSE the reader
// for this client — which reads the [mcp_servers.opencadre] table this same write produces. So
// removing the export leaves awareness, the approval gate and the wake script resolving the same key.
// The last test in this file is that claim, checked rather than asserted in prose: if it were false,
// deleting the export would silently disable three capabilities and every other test here would
// still pass.
//
// PROVENANCE — READ THIS BEFORE TRUSTING ANY CASE BELOW. **The leak was NOT reproduced on this box,**
// and none of these cases drives a real install. Every input here is a **constructed config** written
// to a temp directory: this machine uses the **keyless session server**, so the named-agent path that
// wrote the leak never ran here and its own config carries no `[shell_environment_policy.set]` entry
// at all. The exposure these cases describe is real and is on **named-agent installs**; what is
// measured here is the WRITER's behaviour, not the presence of a live leak.
//
// The tag is worth stating explicitly because this file cites a vendor document with its URL and
// fetch date two paragraphs above, and tags it DOCS. A reader who sees that discipline and then finds
// no equivalent note on the fixtures would reasonably take them for a hardware measurement. Lane 2
// raised exactly that during review, and it is right: the omission was in the one place this file is
// otherwise most careful about provenance.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeCodexToml } from "../cli/lib/clients.mjs";
import { resolveNamedAgent } from "../scripts/opencadre-config.mjs";

const HUB = "https://hub.example.test";
const KEY = `agt_${"a1b2c3d4".repeat(5)}e5`; // agt_ + 44 hex, the shape a real key has
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "oc-codex-envkey-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** The lines of one table and its subtables. The key legitimately appears in the SERVER table's
 * http_headers, so a whole-file search for it would be a false red on a correct config — the
 * exposure is specifically inside the shell environment section. */
function sectionBody(text: string, name: string) {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^[\]]+)\]\s*$/.exec(line);
    if (header) inside = header[1] === name || header[1].startsWith(`${name}.`);
    else if (inside) out.push(line);
  }
  return out.join("\n");
}

const merge = (before: string) => mergeCodexToml(before, { url: `${HUB}/mcp`, hub: HUB, key: KEY });

describe("the agent key is not exported into Codex's shell environment", () => {
  it("writes NO shell_environment_policy.set on a fresh config", () => {
    const { after } = merge("");
    expect(sectionBody(after, "shell_environment_policy")).not.toMatch(/OPENCADRE_(URL|KEY)/);
    expect(after).not.toContain("[shell_environment_policy.set]");
    // The server table still carries the credentials, which is what every consumer reads.
    expect(after).toContain("[mcp_servers.opencadre]");
    expect(after).toContain(`http_headers = { "Authorization" = "Bearer ${KEY}" }`);
  });

  it("REMOVES a stale pair from an install that already has one — old installs stop leaking too", () => {
    // The half that matters for machines already connected: fixing only the writer would leave every
    // existing install exporting its key until someone rebuilt its config from scratch.
    const before = `[shell_environment_policy.set]\nOPENCADRE_URL = "https://old.test"\nOPENCADRE_KEY = "agt_stale"\n`;
    const { after, warnings } = merge(before);
    const env = sectionBody(after, "shell_environment_policy");
    expect(env).not.toMatch(/OPENCADRE_(URL|KEY)/);
    expect(env).not.toContain("agt_stale");
    // And a file whose set-table held ONLY our keys loses the empty header rather than keeping it.
    expect(after).not.toContain("[shell_environment_policy.set]");
    // The removal is reported: a config change that removes lines without saying so is the silence
    // this codebase keeps finding defects behind.
    expect(warnings.join(" ")).toMatch(/removed/i);
  });

  it("keeps every OTHER variable in that table, and removes only ours", () => {
    // The falsifier for the two above: a write that emptied the table would satisfy them and destroy
    // a user's own settings. `MY_VAR` is the world in which "we removed our keys" returns something
    // else if the filter is too broad.
    const before = `[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_stale"\nMY_VAR = "keep-me"\nALSO = "keep-me-too"\n`;
    const { after } = merge(before);
    expect(after).toContain('MY_VAR = "keep-me"');
    expect(after).toContain('ALSO = "keep-me-too"');
    expect(sectionBody(after, "shell_environment_policy")).not.toMatch(/OPENCADRE_(URL|KEY)/);
  });

  it("leaves a table that was never ours entirely alone, header included", () => {
    const before = `[shell_environment_policy.set]\nMY_VAR = "keep-me"\n`;
    const { after, warnings } = merge(before);
    expect(after).toContain("[shell_environment_policy.set]");
    expect(after).toContain('MY_VAR = "keep-me"');
    expect(warnings).toEqual([]);
  });

  it("does not mangle the inline `set = { … }` form, and WARNS when it carries our key", () => {
    // An inline table cannot be edited one key at a time by this line-oriented writer. Reporting it is
    // the honest outcome; silently leaving a live key in the shell environment is the defect.
    const withKey = `[shell_environment_policy]\nset = { OPENCADRE_KEY = "agt_leak", FOO = "bar" }\n`;
    const { after, warnings } = merge(withKey);
    expect(after).toContain('set = { OPENCADRE_KEY = "agt_leak", FOO = "bar" }'); // untouched, not mangled
    expect(warnings.join(" ")).toMatch(/inline shell_environment_policy\.set/);
    expect(warnings.join(" ")).toMatch(/remove them by hand/);
    // And an inline `set` carrying only someone else's variables is not warned about: no false alarm.
    const { warnings: quiet } = merge(`[shell_environment_policy]\nset = { FOO = "bar" }\n`);
    expect(quiet).toEqual([]);
  });

  it("does not touch the `[shell_environment_policy]` parent's own unrelated settings", () => {
    const before = `[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = false\n`;
    const { after } = merge(before);
    expect(after).toContain('inherit = "core"');
    expect(after).toContain("ignore_default_excludes = false");
  });
});

describe("the removal edits a user's file and nothing else — the riskiest half", () => {
  // Stopping a NEW write is safe. Removing a stale pair from a config already on someone's machine is
  // not: a wrong match, a partial edit, or a lost surrounding key damages a working install, and for a
  // credential fix that is a worse outcome than the leak it closes. Every case below is a shape where
  // a careless removal would destroy something that is not ours.

  /** Everything that was in the file EXCEPT our own keys, which are the only thing licensed to vanish.
   * Compared line by line, so a lost variable fails by name rather than as a diff nobody reads. */
  const nonOursLines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() && !/OPENCADRE_(URL|KEY)\s*=/.test(l));

  it("leaves a table alone when OUR KEY IS ABSENT — no edit, no warning", () => {
    const before = `[shell_environment_policy.set]\nFOO = "bar"\nBAZ = "qux"\n`;
    const { after, warnings } = merge(before);
    expect(after).toContain('FOO = "bar"');
    expect(after).toContain('BAZ = "qux"');
    expect(after).toContain("[shell_environment_policy.set]");
    expect(warnings).toEqual([]);
  });

  it("preserves EVERY other variable when ours share the table", () => {
    const before = `[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_old"\nOPENCADRE_URL = "https://old.test"\nFOO = "bar"\nBAZ = "qux"\n`;
    const { after } = merge(before);
    for (const kept of ['FOO = "bar"', 'BAZ = "qux"', "[shell_environment_policy.set]"]) expect(after).toContain(kept);
    expect(sectionBody(after, "shell_environment_policy")).not.toMatch(/OPENCADRE_(URL|KEY)/);
  });

  it("does NOT THROW on a malformed file, and preserves the malformed parts verbatim", () => {
    // The line-oriented writer never parses, so junk is carried rather than rejected. That is the safe
    // direction — but it has to be SHOWN, because a writer that threw here would leave a user with a
    // config that could not be repaired by re-running connect.
    const before = `this is not toml at all\n[other]\nx = "unclosed\n[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_old"\n`;
    const { after } = merge(before);
    expect(after).toContain("this is not toml at all");
    expect(after).toContain('x = "unclosed');
    expect(after).not.toMatch(/OPENCADRE_KEY\s*=/);
    expect(after).toContain("[mcp_servers.opencadre]");
  });

  it("keeps every surrounding table and top-level key byte-for-byte", () => {
    // The intactness bar: nothing outside our own two lines may move. Asserted as a SET of surviving
    // lines rather than a diff, so a lost variable fails by name.
    const before = `top = "keep"\n\n[shell_environment_policy]\ninherit = "core"\n\n[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_old"\nFOO = "bar"\n\n[desktop]\nenabled = true\n`;
    const { after } = merge(before);
    for (const line of nonOursLines(before)) expect(after).toContain(line);
    expect(sectionBody(after, "shell_environment_policy")).not.toMatch(/OPENCADRE_(URL|KEY)/);
  });

  it("survives a duplicate header without losing the second table's contents", () => {
    // TOML forbids this, which is exactly why a user's file may contain it. Both bodies must survive.
    const before = `[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_old"\n[shell_environment_policy.set]\nKEEP = "1"\n`;
    const { after } = merge(before);
    expect(after).toContain('KEEP = "1"');
    expect(after).not.toMatch(/OPENCADRE_KEY\s*=/);
  });

  it("does not leave a stray blank line where the emptied table was", () => {
    // The empty header is dropped, and the drop must not leave a gap that grows on every re-run: the
    // file is compared through a SECOND pass to prove the operation is idempotent rather than merely
    // correct once (a re-run is the normal case -- connect is run again after an upgrade).
    const before = `[shell_environment_policy.set]\nOPENCADRE_KEY = "agt_old"\n`;
    const once = merge(before).after;
    const twice = merge(once).after;
    expect(once).not.toContain("[shell_environment_policy.set]");
    expect(twice).toBe(once); // idempotent: a second connect changes nothing at all
  });
});

describe("the fix does not break the consumers — the claim the whole change rests on", () => {
  it("hooks still resolve the hub and key from the CLIENT CONFIG with the env pair absent", () => {
    // THE SAFETY ARGUMENT, CHECKED. §9 item 8 allows two remedies: stop exporting the key, or move the
    // path to the keyless proxy. This takes the first, which is only sound if every consumer can find
    // the key without the environment. `resolveNamedAgent` is what awareness, the approval gate and
    // the wake script all go through, so this is the load-bearing assertion in the file.
    //
    // The env is stripped of the pair here, which is the condition the removal creates. Its falsifier
    // is the world in which this returns nothing: then the export WAS load-bearing, removing it would
    // silently disable awareness, usage reporting and the gate, and every test above would still pass.
    const home = mkdtempSync(path.join(dir, "home-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const { after } = merge("");
    writeFileSync(path.join(home, ".codex", "config.toml"), after);

    const env = { ...process.env };
    delete env.OPENCADRE_KEY;
    delete env.OPENCADRE_URL;
    const resolved = resolveNamedAgent({ client: "codex", cwd: home, home, env });

    expect(resolved.key).toBe(KEY);
    expect(resolved.base).toBe(HUB);
    // `source` names WHICH reader answered. Asserted so the test cannot pass by some other path
    // (an ambient env key, say) while the client-config reader is broken.
    expect(resolved.source).toBe("codex");
  });
});
