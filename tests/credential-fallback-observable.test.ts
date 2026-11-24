import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainDeviceCredential, readDeviceCredential, resolveHub } from "../scripts/opencadre-config.mjs";

/**
 * The credential fallback must be OBSERVABLE, not silent.
 *
 * `readDeviceCredential` returns the same success shape whether the machine credential was
 * used, whether a machine entry existed but was UNUSABLE and an older per-tool entry was
 * substituted, or whether there is simply no machine entry. The middle case is a masked
 * failure: the agent keeps working as a credential the operator believes was replaced.
 *
 * The fallback itself is deliberate and is NOT removed here — a partial migration is a real
 * state, and refusing to read a legacy file would break a working setup to report a cosmetic
 * problem. These tests pin that the fallback still happens AND that it now says so.
 *
 * Written by DeepSeek-D2V6 (reviewer) after finding the silent path while reviewing migration
 * coverage. The pre-existing test at opencadre-config.test.ts asserts the fallback's
 * behaviour; this file asserts its observability.
 */

const noEnv = { OPENCADRE_HOOK_HOME: "" };
const tempHome = () => mkdtempSync(path.join(tmpdir(), "oc-cred-home-"));
const COMPUTER = `dev_${"ab".repeat(24)}`;
const LEGACY = `dev_${"cd".repeat(24)}`;
const HUB = "http://hub.example/";

const writeCredentials = (home: string, content: object) => {
  mkdirSync(path.join(home, ".opencadre"), { recursive: true });
  writeFileSync(path.join(home, ".opencadre", "credentials.json"), JSON.stringify(content));
};

describe("credential resolution is observable", () => {
  it("reports shape=computer when the machine entry is healthy", () => {
    const home = tempHome();
    writeCredentials(home, { computer: { hub: HUB, credential: COMPUTER, deviceId: "d1" } });
    const r = explainDeviceCredential({ client: "claude-code", home, env: noEnv });
    expect(r.shape).toBe("computer");
    expect(r.machineEntryUnusable).toBe(false);
    expect(r.note).toBeNull();
    expect(r.credential?.credential).toBe(COMPUTER);
  });

  it("THE MASKED CASE: a machine entry that exists but is unusable is REPORTED, not hidden", () => {
    const home = tempHome();
    writeCredentials(home, {
      computer: { hub: HUB, credential: "agt_wrong_prefix", deviceId: "d1" },
      devices: { "claude-code": { hub: HUB, credential: LEGACY, deviceId: "old" } },
    });
    const r = explainDeviceCredential({ client: "claude-code", home, env: noEnv });
    // The fallback still happens - behaviour is preserved deliberately.
    expect(r.credential?.credential).toBe(LEGACY);
    expect(r.shape).toBe("legacy");
    // ...but it is no longer silent.
    expect(r.machineEntryUnusable).toBe(true);
    expect(r.note).toMatch(/not usable/);
    expect(r.note).toMatch(/opencadre connect/);
  });

  it("distinguishes a REJECTED machine entry from an ABSENT one", () => {
    const rejectedHome = tempHome();
    writeCredentials(rejectedHome, {
      computer: { hub: HUB, credential: "agt_bad" },
      devices: { "claude-code": { hub: HUB, credential: LEGACY } },
    });
    const plainHome = tempHome();
    writeCredentials(plainHome, { devices: { "claude-code": { hub: HUB, credential: LEGACY } } });

    const rejected = explainDeviceCredential({ client: "claude-code", home: rejectedHome, env: noEnv });
    const plain = explainDeviceCredential({ client: "claude-code", home: plainHome, env: noEnv });

    // Both use the legacy credential, so readDeviceCredential cannot tell them apart...
    expect(readDeviceCredential({ client: "claude-code", home: rejectedHome, env: noEnv })).toEqual(
      readDeviceCredential({ client: "claude-code", home: plainHome, env: noEnv }),
    );
    // ...but the explanation can, which is the whole point of this function.
    expect(rejected.machineEntryUnusable).toBe(true);
    expect(plain.machineEntryUnusable).toBe(false);
    expect(rejected.note).not.toBe(plain.note);
    expect(plain.note).toMatch(/no "computer" entry/);
  });

  it("explains a machine entry that is present but has no usable credential field", () => {
    const home = tempHome();
    writeCredentials(home, { computer: { hub: HUB }, devices: { "claude-code": { hub: HUB, credential: LEGACY } } });
    const r = explainDeviceCredential({ client: "claude-code", home, env: noEnv });
    expect(r.machineEntryUnusable).toBe(true);
    expect(r.credential?.credential).toBe(LEGACY);
  });

  it("reports the unusable machine entry even when there is nothing to fall back to", () => {
    const home = tempHome();
    writeCredentials(home, { computer: { hub: HUB, credential: "agt_bad" } });
    const r = explainDeviceCredential({ client: "claude-code", home, env: noEnv });
    expect(r.shape).toBe("none");
    expect(r.credential).toBeNull();
    expect(r.machineEntryUnusable).toBe(true);
    expect(r.note).toMatch(/not usable/);
  });

  it("never reports an unusable entry when there was no machine entry at all", () => {
    const home = tempHome();
    writeCredentials(home, {});
    const r = explainDeviceCredential({ client: "claude-code", home, env: noEnv });
    expect(r.shape).toBe("none");
    expect(r.machineEntryUnusable).toBe(false);
    expect(r.note).toBeNull();
  });

  it("resolveHub surfaces the note to its caller instead of dropping it", () => {
    const home = tempHome();
    writeCredentials(home, {
      computer: { hub: HUB, credential: "agt_bad" },
      devices: { "claude-code": { hub: HUB, credential: LEGACY } },
    });
    const resolved = resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "s1", cwd: tempHome() });
    expect(resolved.source).toBe("device");
    expect(resolved.key).toBe(LEGACY);
    // Attached, not printed: this module is imported by the hub and hooks too, so a resolver
    // that wrote to stderr would be noisy. Callers that own a stderr decide what to do.
    expect(resolved.machineEntryUnusable).toBe(true);
    expect(resolved.credentialNote).toMatch(/not usable/);
  });

  it("a healthy machine entry adds no note, so normal operation stays quiet", () => {
    const home = tempHome();
    writeCredentials(home, { computer: { hub: HUB, credential: COMPUTER, deviceId: "d1" } });
    const resolved = resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "s1", cwd: tempHome() });
    expect(resolved.credentialNote).toBeUndefined();
    expect(resolved.machineEntryUnusable).toBeUndefined();
  });

  it("a plain legacy install is NOT annotated either - only the abnormal case is", () => {
    // A legacy-only file is a legitimate state, not a fault. Annotating it would change
    // resolveHub's return shape on the ORDINARY path, which broke a caller asserting that
    // shape when this was first written. A note that fires on a healthy path is noise.
    const home = tempHome();
    writeCredentials(home, { devices: { "claude-code": { hub: HUB, credential: LEGACY, deviceId: "old" } } });
    const resolved = resolveHub({ client: "claude-code", home, env: noEnv, sessionId: "s1", cwd: tempHome() });
    expect(resolved.source).toBe("device");
    expect(resolved.key).toBe(LEGACY);
    expect(resolved.credentialNote).toBeUndefined();
    expect(resolved.machineEntryUnusable).toBeUndefined();
  });
});