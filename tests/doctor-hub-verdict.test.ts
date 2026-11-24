// doctor is the instrument behind every "Verified" cell (LAUNCH-CLIENT-GATE.md §1), so its exit code must change when
// the hub stops accepting the computer. Measured 2026-09-26 (scripts/dev/claude-live-smoke.ts): on a connected
// claude-code home whose credential the hub REJECTED, doctor printed "[red] Hub rejected this computer's credential",
// then "Inbox loop healthy", verdict=healthy, exit 0. The three homes below differ ONLY in the stored credential or
// hub, and each is a world in which a healthy verdict would be false.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv, CLI, gitProject, mintDevice, operatorWorkspace, runNode, startHub, tempDir } from "./helpers/device-hub.js";

process.env.OPENCADRE_CONNECT_REDEEM_PER_MIN = "1000";

let hub: Awaited<ReturnType<typeof startHub>>;
let home: string;
beforeAll(async () => {
  hub = await startHub();
  const { operatorKey } = await operatorWorkspace("Doctor verdict");
  const minted = await mintDevice(hub.url, operatorKey);
  home = tempDir("oc-doctor-verdict-");
  const connected = await runNode(CLI, ["connect", "--hub", hub.url, "--code", minted.code, "--home", home, "--client", "claude-code"], childEnv(home), gitProject("DoctorVerdict"));
  expect(connected.code, connected.err).toBe(0);
}, 60_000);
afterAll(() => hub.close());

const doctor = () => runNode(CLI, ["doctor", "--client", "claude-code", "--home", home], childEnv(home));
const credsFile = () => path.join(home, ".opencadre", "credentials.json");
async function withCredentials(edit: (text: string) => string, check: (r: Awaited<ReturnType<typeof doctor>>) => void) {
  const saved = readFileSync(credsFile(), "utf8");
  writeFileSync(credsFile(), edit(saved));
  try {
    check(await doctor());
  } finally {
    writeFileSync(credsFile(), saved);
  }
}

describe("doctor's verdict follows the hub, for a session-server machine", () => {
  it("the connected home: healthy, exit 0", async () => {
    const r = await doctor();
    expect(r.out).toMatch(/verdict=healthy/);
    expect(r.code).toBe(0);
  });

  it("a credential the hub does not know: red line, check_hub, exit 1 -- never 'healthy' under the red line", async () => {
    await withCredentials((t) => t.replace(/dev_[A-Za-z0-9]+/, `dev_${"0".repeat(48)}`), (r) => {
      expect(r.out).toMatch(/\[red\] Hub rejected this computer's credential \(HTTP 401\)/);
      expect(r.out).toMatch(/verdict=check_hub/);
      expect(r.out).not.toMatch(/verdict=healthy|Inbox loop healthy|Session server connected/);
      expect(r.code).toBe(1);
    });
  });

  it("a hub that was never checked (the stored hub address is empty): check_hub, never 'connected' under the red line", async () => {
    // Found by Codex-OpenCadre-049a on 10389c71: the connected branch listed rejected/unreachable/error by hand and
    // missed `unknown`, the value hub_identity keeps when the probe is skipped.
    await withCredentials((t) => t.replace(/"hub"\s*:\s*"[^"]*"/, '"hub": ""'), (r) => {
      expect(r.out).toMatch(/\[red\] Hub check skipped/);
      expect(r.out).toMatch(/hub_identity=unknown/);
      expect(r.out).toMatch(/verdict=check_hub/);
      expect(r.out).not.toMatch(/verdict=healthy|Session server connected/);
      expect(r.code).toBe(1);
    });
  });

  it("a hub that cannot be reached: check_hub, exit 1", async () => {
    await withCredentials((t) => t.replace(hub.url, "http://127.0.0.1:1"), (r) => {
      expect(r.out).toMatch(/hub_identity=unreachable/);
      expect(r.out).toMatch(/verdict=check_hub/);
      expect(r.code).toBe(1);
    });
  });
});
