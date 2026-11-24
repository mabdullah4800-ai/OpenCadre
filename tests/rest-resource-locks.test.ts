import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { app } from "../src/rest.js";
import { createOrganization, registerAgent } from "../src/service.js";

// Board task 081baee9 over REST: renew(60 s) on a lock held until 12:42 cut it to 12:13, and a holder's re-claim
// answered 200 with nothing saying it was already theirs.
let baseUrl: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function post(key: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function org(name: string) {
  const { orgId } = createOrganization(name);
  return { a: registerAgent(orgId, "Agent A").apiKey, b: registerAgent(orgId, "Agent B").apiKey };
}

describe("resource lock leases over REST", () => {
  it("POST /v1/resources/renew never shortens a lease, and says whether it changed", async () => {
    const { a } = org("REST Renew Org");
    const claimed = await post(a, "/v1/resources/claim", { resourceKey: "repo", leaseSeconds: 3600 });
    expect(claimed.status).toBe(200);
    const until = claimed.body.lock.lease_expires_at;

    const short = await post(a, "/v1/resources/renew", { resourceKey: "repo", leaseSeconds: 60 });
    expect(short.status).toBe(200);
    expect(short.body).toMatchObject({ ok: true, leaseChanged: false, leaseExpiresAt: until });
    expect(short.body.lock.lease_expires_at).toBe(until);

    const long = await post(a, "/v1/resources/renew", { resourceKey: "repo", leaseSeconds: 7200 });
    expect(long.body).toMatchObject({ ok: true, leaseChanged: true });
    expect(Date.parse(long.body.leaseExpiresAt)).toBeGreaterThan(Date.parse(until));
  });

  it("POST /v1/resources/claim by the holder returns alreadyHeld, whether the lease changed, and the expiry", async () => {
    const { a, b } = org("REST Reclaim Org");
    const first = await post(a, "/v1/resources/claim", { resourceKey: "repo", leaseSeconds: 3600 });
    expect(first.body).toMatchObject({ ok: true, alreadyHeld: false });
    const until = first.body.lock.lease_expires_at;

    const same = await post(a, "/v1/resources/claim", { resourceKey: "repo", leaseSeconds: 60 });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ ok: true, alreadyHeld: true, leaseChanged: false, leaseExpiresAt: until });

    const longer = await post(a, "/v1/resources/claim", { resourceKey: "repo", leaseSeconds: 7200 });
    expect(longer.body).toMatchObject({ ok: true, alreadyHeld: true, leaseChanged: true });
    expect(Date.parse(longer.body.leaseExpiresAt)).toBeGreaterThan(Date.parse(until));

    const blocked = await post(b, "/v1/resources/claim", { resourceKey: "repo" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body).not.toHaveProperty("alreadyHeld");
  });
});
