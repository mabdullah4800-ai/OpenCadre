// #692 follow-up (Codex-049a): a RECORDED Codex hook trust is not proof the hooks run. Codex runs a hook only while its
// recorded `trusted_hash` equals the hook's current hash (event + matcher + whole normalised handler; openai/codex
// codex-rs/hooks/src/engine/discovery.rs hook_hash at rust-v0.157.0), and doctor does not recompute that hash.
//
// So doctor keeps THREE trust states distinct for a fully connected, fully configured Codex home:
//   hooks_disabled                red, exit 1:  an OpenCadre hook is switched off in Codex (`enabled = false`), READ directly
//   hooks_untrusted (and partial) red, exit 1:  trust records missing or partial, READ directly
//   hook_trust_unverified         amber, exit 3: trust recorded, current validity unknown -- not green, not a fault
// and never "healthy". There is NO "known stale" state (review of #692 at f640bf73): without a hash implementation
// measured to match Codex's, not even OpenCadre's own change proves a recorded trust stale (restoring an older,
// already-trusted config is the counterexample). OpenCadre's change history is an amber NOTE with a date, nothing more.
// Every case runs through the SESSION-SERVER branch, the branch that used to turn "recorded" green.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpDir } from "./helpers/tmp.js";
import { HOOK_MARKERS, planSessionHooks } from "../cli/lib/session-hooks.mjs";
import { planCodexSessionServer } from "../cli/lib/device.mjs";
import { installHelpers } from "../cli/lib/generations.mjs";
import { applyReconcile } from "../cli/lib/reconcile.mjs";
import { runDoctor } from "../cli/lib/doctor.mjs";

delete process.env.CODEX_HOME;

let hub: Server;
let hubUrl: string;
beforeAll(async () => {
  hub = createServer((req, res) => {
    if (req.url === "/v1/devices/me") {
      res.writeHead(200, { "content-type": "application/json", "x-opencadre-probe": "no-heartbeat" });
      return res.end(JSON.stringify({ name: "Test computer" }));
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => hub.close(() => r())));

const snake = (e: string) => e.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The slots Codex keys trust by, for every OpenCadre handler in the hooks file (doctor's own rule). */
function ourSlots(hooksFile: string): string[] {
  const config = JSON.parse(readFileSync(hooksFile, "utf8"));
  const slots: string[] = [];
  for (const [event, groups] of Object.entries(config.hooks as Record<string, { hooks: { command: string }[] }[]>)) {
    groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
      if (Object.values(HOOK_MARKERS).some((m) => h.command.includes(m))) slots.push(`${snake(event)}:${gi}:${hi}`);
    }));
  }
  return slots;
}

/** Records trust (as Codex would after the user trusted the hooks) for every OpenCadre slot, with a given hash value. */
function recordTrust(home: string, hooksFile: string, value: (slot: string) => string, extra: (slot: string) => string = () => "") {
  const config = path.join(home, ".codex", "config.toml");
  const base = readFileSync(config, "utf8").replace(/\n\[hooks\.state[\s\S]*$/, "\n");
  writeFileSync(config, `${base}\n${ourSlots(hooksFile).map((s) => `[hooks.state.'${hooksFile}:${s}']\ntrusted_hash = "${value(s)}"\n${extra(s)}`).join("\n")}`);
}

/** A fully connected Codex computer: session server, current hooks, current helpers, a credential the hub accepts. */
function connectedCodex() {
  const home = tmpDir("oc-trust-ready-");
  const bin = path.join(home, ".opencadre", "bin");
  const server = planCodexSessionServer({ home, proxyPath: path.join(bin, "opencadre-mcp.mjs") });
  mkdirSync(path.dirname(server.file), { recursive: true });
  writeFileSync(server.file, server.after);
  const hooks = planSessionHooks({
    home, client: "codex",
    awarenessPath: path.join(bin, "opencadre-awareness.mjs"), wakePath: path.join(bin, "opencadre-wake.mjs"), usagePath: path.join(bin, "opencadre-usage.mjs"),
    gatePath: path.join(bin, "opencadre-approval-gate.mjs"), stampPath: path.join(bin, "opencadre-session-stamp.mjs"),
  });
  writeFileSync(hooks.file, hooks.after);
  installHelpers(bin);
  // The same all-zero placeholder the other doctor suites use: shaped like a credential, valid nowhere.
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify({ computer: { hub: hubUrl, credential: `dev_${"0".repeat(48)}`, deviceId: "00000000-0000-0000-0000-000000000000" } }));
  recordTrust(home, hooks.file, (s) => `sha256:recorded-${s}`);
  return { home, hooksFile: hooks.file };
}
const doctor = async (home: string) => {
  const r = await runDoctor({ client: "codex", home });
  return { ...r, text: r.lines.join("\n") };
};
const OLD_MATCHER = "Edit|Write|Bash|apply_patch";
/** Puts an older PostToolUse matcher back (a field Codex hashes), so the next upgrade changes it. */
function makeOldMatcher(hooksFile: string) {
  const config = JSON.parse(readFileSync(hooksFile, "utf8"));
  config.hooks.PostToolUse[0].matcher = OLD_MATCHER;
  writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
}
/** No false certainty: amber unverified, never a red trust claim, never "stale" or "will skip". */
function noCertainty(r: { text: string; healthy: boolean; actionRequired?: boolean }) {
  expect(r.text).toMatch(/verdict=hook_trust_unverified/);
  expect(r.healthy).toBe(false);
  expect(r.actionRequired).toBe(true);
  expect(r.text).not.toMatch(/hooks_retrust_needed|hook_trust=changed|known stale|\bstale trust|will skip|until you trust them again/i);
  expect(r.text).not.toMatch(/\[red\][^\n]*(trust|Settings > Hooks)/);
}

describe("doctor: recorded Codex hook trust is amber, never green", () => {
  it("(b) an unchanged install with recorded trust is hook_trust_unverified: amber, exit-3 class, not healthy", async () => {
    const { home } = connectedCodex();
    const r = await doctor(home);
    expect(r.text).toMatch(/key=session/); // the session-server branch
    expect(r.text).toMatch(/\[amber\] Codex has recorded hook trust for this hooks\.json[^\n]*recorded, current validity unverified/);
    expect(r.text).toMatch(/Settings > Hooks \(or run \/hooks in Codex CLI\)/);
    expect(r.text).toMatch(/verdict=hook_trust_unverified/);
    expect(r.text).not.toMatch(/verdict=healthy|Session server connected/);
    expect(r.healthy).toBe(false);
    expect(r.actionRequired).toBe(true);
    // Not a claim that the hooks are untrusted, and no instruction to re-trust an unchanged install.
    expect(r.text).not.toMatch(/not trusted|trust them again/);
  });

  it("(a) a hashed field OpenCadre changed after trust was recorded: amber plus a dated per-change review note, never a red certainty", async () => {
    const { home, hooksFile } = connectedCodex();
    makeOldMatcher(hooksFile);
    recordTrust(home, hooksFile, (s) => `sha256:old-${s}`);
    const applied = applyReconcile({ home, now: new Date("2026-10-01T12:00:00Z") });
    expect(applied.clients.find((c: { client: string }) => c.client === "codex")!.parts.find((p: { kind: string }) => p.kind === "hooks")!.status).toBe("applied");
    const r = await doctor(home);
    expect(r.text).toMatch(/key=session/);
    expect(r.text).toMatch(/\[amber\] OpenCadre changed these hooks on 2026-10-01 \(generation [0-9a-f]{12}\): PostToolUse awareness[^\n]*Review status unverified/);
    expect(r.text).toMatch(/hook_trust=recorded/);
    noCertainty(r);
    // The record is OpenCadre's change history only: no Codex trust value in it.
    expect(readFileSync(path.join(home, ".opencadre", "codex-hook-changes.json"), "utf8")).not.toMatch(/sha256|trusted|stale/i);
  });

  it("(a) control: a hashed field changed BY HAND (nothing recorded it) is never healthy either; amber, unverified", async () => {
    const { home, hooksFile } = connectedCodex();
    const config = JSON.parse(readFileSync(hooksFile, "utf8"));
    config.hooks.PreToolUse[0].hooks[0].timeout = 601; // hashed by Codex; trust above was recorded for 600
    writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
    const r = await doctor(home);
    expect(r.text).toMatch(/key=session/);
    expect(r.text).not.toMatch(/verdict=healthy|Session server connected/);
    expect(r.text).toMatch(/verdict=hook_trust_unverified/);
    expect(r.healthy).toBe(false);
  });

  it("a hook switched OFF in Codex is a red fault (hooks_disabled), with basic-quoted Windows keys and comments read", async () => {
    const { home, hooksFile } = connectedCodex();
    const configToml = path.join(home, ".codex", "config.toml");
    const base = readFileSync(configToml, "utf8").replace(/\n\[hooks\.state[\s\S]*$/, "\n");
    // Basic-quoted keys, the JSON-string form: every backslash escaped. Comments after the header and the value.
    writeFileSync(configToml, `${base}\n${ourSlots(hooksFile).map((s, i) => `[hooks.state.${JSON.stringify(`${hooksFile}:${s}`)}] # trusted in the app\ntrusted_hash = "sha256:x-${s}" # recorded\n${i === 0 ? "enabled = false # switched off\n" : ""}`).join("\n")}`);
    const r = await doctor(home);
    expect(r.text).toMatch(/hook_trust=disabled/);
    expect(r.text).toMatch(/verdict=hooks_disabled/);
    expect(r.healthy).toBe(false);
  });

  it("basic-quoted Windows keys are DECODED: an all-trusted basic-quoted config reads as recorded, not 'other source'", async () => {
    const { home, hooksFile } = connectedCodex();
    const configToml = path.join(home, ".codex", "config.toml");
    const base = readFileSync(configToml, "utf8").replace(/\n\[hooks\.state[\s\S]*$/, "\n");
    writeFileSync(configToml, `${base}\n${ourSlots(hooksFile).map((s) => `[hooks.state.${JSON.stringify(`${hooksFile}:${s}`)}]\ntrusted_hash = "sha256:x-${s}"\n`).join("\n")}`);
    const r = await doctor(home);
    expect(r.text).toMatch(/hook_trust=recorded/);
    expect(r.text).toMatch(/verdict=hook_trust_unverified/);
  });
});

// Olive's two chronology scenarios (B:/ai-work/temp/olive-692-f640-review-20261001/olive-692-retrust-epochs.mjs) and the
// main reviewer's restored-configuration counterexample: each must produce NO certainty -- only amber "unverified".
describe("no false certainty about Codex trust, whatever the chronology", () => {
  it("chronology A: a user review written between the rename and the record is never labelled stale", async () => {
    const { home, hooksFile } = connectedCodex();
    makeOldMatcher(hooksFile);
    recordTrust(home, hooksFile, () => "sha256:synthetic-before");
    applyReconcile({ home, onStep: (s: string, info: { file: string }) => {
      if (s === "replaced" && info.file === hooksFile) recordTrust(home, hooksFile, () => "sha256:synthetic-after-user-review");
    } });
    noCertainty(await doctor(home));
  });

  it("chronology B: change -> re-trust -> change again: amber each time, and the note dates the latest change", async () => {
    const { home, hooksFile } = connectedCodex();
    makeOldMatcher(hooksFile);
    recordTrust(home, hooksFile, () => "sha256:synthetic-epoch-A");
    applyReconcile({ home, now: new Date("2026-10-01T10:00:00Z") });
    noCertainty(await doctor(home));
    recordTrust(home, hooksFile, () => "sha256:synthetic-epoch-B-user-trusted");
    noCertainty(await doctor(home));
    makeOldMatcher(hooksFile);
    applyReconcile({ home, now: new Date("2026-10-02T10:00:00Z") });
    const r = await doctor(home);
    noCertainty(r);
    expect(r.text).toMatch(/OpenCadre changed these hooks on 2026-10-02 [^\n]*PostToolUse awareness/);
  });

  it("restored configuration: OpenCadre changed a hook, then the user restored the older, already-trusted one: no stale claim", async () => {
    const { home, hooksFile } = connectedCodex();
    makeOldMatcher(hooksFile);
    const trustedOld = readFileSync(hooksFile, "utf8");
    recordTrust(home, hooksFile, (s) => `sha256:trusted-for-old-${s}`);
    applyReconcile({ home });
    writeFileSync(hooksFile, trustedOld); // the user restores the configuration Codex had already trusted
    noCertainty(await doctor(home));
  });
});
