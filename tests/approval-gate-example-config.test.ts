import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOrganization, registerAgent } from "../src/service.js";
import { requestApproval } from "../src/approvals.js";

/**
 * G7 of the hub-ops survey (docs/ops/HUB-OPERATIONS.md §7).
 *
 * #277 removed the name-keyed `approver` field from the repo's own approval-gate config after a
 * stale one failed the fleet's gate closed for an hour (HUB-OPERATIONS §4), and
 * tests/approval-hook.test.ts enforces that for `.opencadre/approval-gate.json`. The *shipped
 * example* -- which examples/hooks/README.md tells a user to copy -- kept setting `approver` to a
 * fixed agent name. A name only resolves if some agent in *that* workspace holds it, so the
 * example taught the pattern the project had already retired.
 *
 * These tests read the shipped artifact rather than restating it, so they cannot drift from it.
 */
describe("the shipped approval-gate example config", () => {
  const exampleConfig = () =>
    JSON.parse(
      readFileSync(new URL("../examples/hooks/approval-gate.config.example.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

  function workspace() {
    const { orgId } = createOrganization("Example Config Org");
    const coder = registerAgent(orgId, "Coder");
    return { orgId, coder: { id: coder.agentId, name: "Coder" } };
  }

  it("names no fixed approver, the same rule the repo's own config follows", () => {
    expect("approver" in exampleConfig()).toBe(false);
  });

  it("...because a name the workspace does not have is refused at creation", async () => {
    const { orgId, coder } = workspace();

    await expect(
      requestApproval(orgId, coder, { action: "rm -rf dist", risk: "high", approver: "Operator" }),
    ).rejects.toThrow(/No agent found matching approver "Operator"/);
  });

  it("...and because an approver left unset still creates a request the operators can decide", async () => {
    const { orgId, coder } = workspace();
    const example = exampleConfig();

    const req = await requestApproval(orgId, coder, { action: "rm -rf dist", risk: "high" });

    expect(req.status).toBe("pending");
    // The example ships no approver, so the fallback the gate relies on is the example's own default.
    expect("approver" in example).toBe(false);
  });
});
