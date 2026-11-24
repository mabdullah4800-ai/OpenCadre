import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";
import { runInboxSmoke } from "../examples/clients/lib/inbox-smoke.mjs";

const CLIENT_SMOKE_SCRIPTS = [
  "examples/clients/antigravity-smoke.sh",
  "examples/clients/claude-code-smoke.sh",
  "examples/clients/cursor-local-smoke.sh",
  "examples/clients/cursor-cloud-smoke.sh",
  "examples/clients/codex-smoke.sh",
  "examples/clients/gemini-cli-smoke.sh",
  "examples/clients/grok-smoke.sh",
  "examples/clients/kimi-smoke.sh",
  "examples/clients/qwen-smoke.sh",
  "examples/clients/rest-smoke.sh",
];

describe("client example smoke scripts", () => {
  it.each(CLIENT_SMOKE_SCRIPTS)("%s exists and is executable", async (script) => {
    const { access, constants } = await import("node:fs/promises");
    await expect(access(script, constants.X_OK)).resolves.toBeUndefined();
  });
});

describe("runInboxSmoke (local REST)", () => {
  let baseUrl: string;
  let server: ReturnType<typeof app.listen>;
  let senderKey: string;
  let receiverKey: string;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { orgId } = createOrganization("Smoke Org");
    senderKey = registerAgent(orgId, "Smoke-Sender").apiKey;
    receiverKey = registerAgent(orgId, "Smoke-Receiver").apiKey;
  });

  afterAll(() => {
    server.close();
  });

  it("REST mode completes connect → send → receive → reply", async () => {
    process.env.OPENCADRE_SUPERVISOR = "Smoke-Receiver";
    const result = await runInboxSmoke({
      mode: "rest",
      client: "rest",
      restBaseUrl: baseUrl,
      senderKey,
      receiverKey,
    });
    expect(result.pass).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["connect", "send", "receive", "reply"]);
  });
});
