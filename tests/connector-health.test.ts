import { describe, expect, it } from "vitest";
import { connectorHealth, mergeConnectorReports, validateConnectorReport } from "../src/connector-health.js";
const report = () => ({ schema: 1, client: "codex", component: "hooks", installationId: "a".repeat(32), bundleId: "123456789abc", integrity: "matches-metadata", helpers: { "opencadre-config.mjs": "a".repeat(64) } });
const target = { "opencadre-config.mjs": "a".repeat(64) };
describe("reported connector builds are advisory, never identity or compatibility verdicts", () => {
  it("validates a bounded report and rejects paths, unknown fields and malformed hashes", () => {
    expect(validateConnectorReport(report())).not.toBeNull();
    for (const bad of [{ ...report(), deviceId: "other" }, { ...report(), helpers: { "../credentials.json": "a".repeat(64) } }, { ...report(), helpers: { "opencadre-config.mjs": "bad" } }, { ...report(), client: "invented" }, { ...report(), component: ["hooks"] }, { ...report(), integrity: ["matches-metadata"] }]) expect(validateConnectorReport(bad)).toBeNull();
  });
  it("rejects a huge helper-name key before it can enlarge a device inventory", () => {
    const name = "opencadre-" + "x".repeat(200000) + ".mjs";
    expect(validateConnectorReport({ ...report(), helpers: { [name]: "a".repeat(64) } })).toBeNull();
  });
  it("keeps different simultaneous bundles visible instead of replacing an old report with a current one", () => {
    const old = { ...report(), helpers: { "opencadre-config.mjs": "b".repeat(64) } };
    let reports = mergeConnectorReports("[]", validateConnectorReport(old)!, 1000);
    reports = mergeConnectorReports(JSON.stringify(reports), validateConnectorReport({ ...report(), bundleId: "abcdef012345" })!, 2000);
    expect(reports).toHaveLength(2);
    expect(connectorHealth(JSON.stringify(reports), target, 3000).status).toBe("update-available");
  });
  it("distinguishes unknown, reported current, optional update and modified files; stale reports become unknown", () => {
    const current = JSON.stringify(mergeConnectorReports("[]", validateConnectorReport(report())!, 1000));
    expect(connectorHealth(current, target, 2000).status).toBe("reported-current");
    expect(connectorHealth(current, null, 2000).status).toBe("unknown");
    expect(connectorHealth(current, target, 1000 + 24 * 3600000).status).toBe("unknown");
    expect(connectorHealth("garbage", target, 2000).status).toBe("unknown");
    const modified = JSON.stringify(mergeConnectorReports("[]", validateConnectorReport({ ...report(), integrity: "modified-or-missing" })!, 1000));
    expect(connectorHealth(modified, target, 2000).status).toBe("check-installation");
  });
});
